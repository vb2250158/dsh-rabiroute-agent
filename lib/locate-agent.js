import { managerRequest, resolveManagerBase } from './connection.js'

/**
 * Host-side handler for the "locate the sending Agent" action.
 *
 * A Rabi envelope names a session in *another* client. The DSH browser cannot act on
 * that by itself: `codex` rows belong to the Codex desktop window, and Rabi declares no
 * CORS policy for the DSH origin, so a browser fetch to the Manager would be blocked.
 * The Host therefore answers for the browser, exactly as the plan panel does.
 *
 * This module locates; it does not decide. Which session ids exist, which adapter owns
 * one, and whether the target can be brought forward is Rabi's business — the request is
 * forwarded to the same `action=open` bridge Rabi's own UI uses, and Rabi's own rejection
 * travels back verbatim. Nothing here opens, creates, or renames a session.
 */

/** The bridge that already owns `action=open`, and the adapter values it accepts. */
export const AGENT_THREADS_PATH = '/api/agent/threads'
export const LOCATE_AGENT_PATH = '/rabiroute/locate-agent'
const THREAD_CAPABLE_ADAPTERS = ['codex', 'dsh']

/**
 * Forward one locate request to Rabi's Agent-thread bridge.
 *
 * `dsh` is answered locally instead: a DSH session lives in the client that is already
 * open, so it is selected in place rather than round-tripped. Every other adapter is
 * Rabi's to resolve.
 * @param config - plugin config carrying `managerBaseUrl` / `hostExecutable` / `requestTimeoutMs`.
 * @param target - `{ agentAdapter, threadId }` taken from the envelope.
 * @param signal - cancels the request.
 * @param dependencies - test seams for the Manager request.
 * @returns the outcome Rabi reported, or a stated reason it could not be asked.
 */
export async function locateRabiSender(config, target, signal, dependencies = {}) {
  const agentAdapter = String(target?.agentAdapter || '').trim().toLowerCase()
  const threadId = String(target?.threadId || '').trim()
  if (!agentAdapter) return { ok: false, reason: 'no-adapter', message: 'The message names no Agent adapter.' }
  if (!threadId) return { ok: false, reason: 'no-thread', message: 'The message names no session id to locate.' }
  // The envelope's own claim decides nothing: an adapter Rabi's bridge cannot open is
  // reported as unsupported rather than forwarded to be rejected with a vaguer message.
  if (!THREAD_CAPABLE_ADAPTERS.includes(agentAdapter)) {
    return { ok: false, reason: 'unsupported-adapter', message: `Locating an Agent on adapter "${agentAdapter}" is not supported.` }
  }
  const request = dependencies.managerRequest || managerRequest
  const body = JSON.stringify({ action: 'open', agentAdapter, threadId })
  const result = await request(config, AGENT_THREADS_PATH, { method: 'POST', body }, signal, dependencies)
  // `managerRequest` returns the Manager's own payload as a JSON string, not as a
  // parsed object, so the receipt is re-read here rather than assumed.
  const payload = parsePayload(result.body)
  if (result.ok) {
    // The thread bridge answers flat (`code, action, threadId, thread, owner`), unlike
    // the storage APIs that wrap results in `data`. Read the flat shape first and keep
    // the wrapped one as a fallback, so a future unification cannot silently blank this.
    const receipt = payload?.data && typeof payload.data === 'object' ? payload.data : payload ?? {}
    return {
      ok: true,
      reason: 'opened',
      agentAdapter,
      threadId,
      // Rabi names the window it handed the session to; the browser only reports it.
      owner: String(receipt.owner || ''),
      title: String(receipt.thread?.title || ''),
    }
  }
  const message = String(payload?.message || result.error?.message || `RabiRoute returned HTTP ${result.statusCode}.`)
  return { ok: false, reason: (result.error?.kind || 'manager-rejected').replace(/_/g, '-'), message, uncertain: Boolean(result.uncertain) }
}

/** Re-read one Manager payload; a non-JSON body is not a reason to lose the failure. */
function parsePayload(body) {
  try {
    const parsed = JSON.parse(String(body || ''))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function sendJson(response, statusCode, body) {
  const text = JSON.stringify(body)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/**
 * Build the HTTP handler for the locate route.
 *
 * A locate never throws at the browser: the reason travels as data so the row can say why
 * it did not move instead of losing the click. Only the adapter and session id travel in;
 * no message body and no Manager credential is proxied.
 * @param config - plugin config.
 * @param dependencies - test seams passed through to the locate call.
 * @returns a `node:http` request handler owning its own response.
 */
export function createLocateAgentHandler(config, dependencies = {}) {
  return async function locateAgentHandler(request, response) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { code: -1, message: 'Method not allowed.' })
      return
    }
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
    const controller = new AbortController()
    // Abort only when the *connection* goes away before this handler answered. Watching
    // the request stream's `close` would fire the moment the body is consumed, cancelling
    // every locate; watching the finished response is what distinguishes the two.
    const abort = () => controller.abort(new Error('Locate request was cancelled by the client.'))
    response.on('close', () => { if (!response.writableEnded) abort() })
    let body = {}
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 200, { code: 0, data: { ok: false, reason: 'bad-request', message: error instanceof Error ? error.message : String(error) } })
      return
    }
    const target = {
      agentAdapter: String(body.agentAdapter ?? requestUrl.searchParams.get('agentAdapter') ?? ''),
      threadId: String(body.threadId ?? requestUrl.searchParams.get('threadId') ?? ''),
    }
    try {
      // Wait for the Manager base first so an unreachable Manager is reported as such
      // rather than as a bad session id.
      await (dependencies.resolveManagerBase || resolveManagerBase)(config, controller.signal, dependencies)
      sendJson(response, 200, { code: 0, data: await locateRabiSender(config, target, controller.signal, dependencies) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(response, 200, { code: 0, data: { ok: false, reason: 'unreachable', message } })
    }
  }
}

/** Read one small JSON object body; anything else is a client error, not a locate failure. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('The locate request body is too large.'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      let parsed
      try { parsed = JSON.parse(text) } catch { return reject(new Error('The locate request body is not valid JSON.')) }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(new Error('The locate request body must be one JSON object.'))
      resolve(parsed)
    })
    request.on('error', reject)
  })
}
