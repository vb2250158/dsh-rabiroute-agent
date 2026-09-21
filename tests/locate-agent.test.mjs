import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { AGENT_THREADS_PATH, createLocateAgentHandler, LOCATE_AGENT_PATH, locateRabiSender } from '../lib/locate-agent.js'

const base = 'http://127.0.0.1:1728'
const config = { managerBaseUrl: '' }

/**
 * A Manager whose `action=open` outcome is given. The default body is the **flat** receipt
 * the thread bridge actually returns (`code, action, threadId, thread, owner`) — verified
 * against a live Manager on 2026-09-17. It is deliberately not the `data`-wrapped shape the
 * storage APIs use, because assuming that shape silently blanked the owner and title.
 * `onCall` records what the plugin forwarded, so a test can prove only the adapter and
 * session id travels.
 */
const manager = ({ ok = true, statusCode = 200, body = { code: 0, action: 'open', agentAdapter: 'codex', threadId: 'task-abc', thread: { id: 'task-abc', title: 'Example' }, status: 'opened', owner: 'codex_desktop' }, error, uncertain = false, onCall } = {}) => ({
  managerRequest: async (cfg, pathname, init) => {
    onCall?.(cfg, pathname, init)
    return {
      statusCode, ok, body: JSON.stringify(body), headers: {}, etag: '',
      uncertain, ...(error ? { error } : {}),
    }
  },
  resolveManagerBase: async () => base,
})

test('a codex sender is forwarded to Rabi as an exact open request', async () => {
  const calls = []
  const result = await locateRabiSender(config, { agentAdapter: 'codex', threadId: 'task-abc' }, new AbortController().signal,
    manager({ onCall: (cfg, pathname, init) => calls.push([pathname, init.method, JSON.parse(init.body)]) }))
  assert.deepEqual(calls, [[AGENT_THREADS_PATH, 'POST', { action: 'open', agentAdapter: 'codex', threadId: 'task-abc' }]])
  assert.deepEqual(result, { ok: true, reason: 'opened', agentAdapter: 'codex', threadId: 'task-abc', owner: 'codex_desktop', title: 'Example' })
})

test('the flat thread-bridge receipt is read directly and a data-wrapped one still works', async () => {
  const flat = await locateRabiSender(config, { agentAdapter: 'codex', threadId: 't' }, new AbortController().signal,
    manager({ body: { code: 0, status: 'opened', owner: 'codex_desktop', thread: { title: '来自扁平回执' } } }))
  assert.equal(flat.owner, 'codex_desktop')
  assert.equal(flat.title, '来自扁平回执')
  const wrapped = await locateRabiSender(config, { agentAdapter: 'codex', threadId: 't' }, new AbortController().signal,
    manager({ body: { code: 0, data: { status: 'opened', owner: 'dsh_web', thread: { title: '来自 data 包裹' } } } }))
  assert.equal(wrapped.owner, 'dsh_web')
  assert.equal(wrapped.title, '来自 data 包裹')
})

test('a flat receipt with no owner does not invent one', async () => {
  const result = await locateRabiSender(config, { agentAdapter: 'codex', threadId: 't' }, new AbortController().signal,
    manager({ body: { code: 0, status: 'opened' } }))
  assert.equal(result.ok, true)
  assert.equal(result.owner, '')
  assert.equal(result.title, '')
})

test('the adapter is normalised and an explicit dsh target is forwarded the same way', async () => {
  const result = await locateRabiSender(config, { agentAdapter: 'DSH', threadId: 'session-1' }, new AbortController().signal, manager())
  assert.equal(result.ok, true)
  assert.equal(result.agentAdapter, 'dsh')
})

test('Rabi own rejection reason travels back verbatim instead of being replaced', async () => {
  const result = await locateRabiSender(config, { agentAdapter: 'codex', threadId: 'task-gone' }, new AbortController().signal,
    manager({ ok: false, statusCode: 404, body: { code: -1, message: 'Agent task could not be read by exact ID: task-gone' } }))
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'manager-rejected')
  assert.match(result.message, /Agent task could not be read by exact ID: task-gone/)
})

test('an adapter Rabi cannot open is refused before any request is sent', async () => {
  const calls = []
  for (const agentAdapter of ['claude', 'gemini', '']) {
    const result = await locateRabiSender(config, { agentAdapter, threadId: 'x' }, new AbortController().signal,
      manager({ onCall: () => calls.push(agentAdapter) }))
    assert.equal(result.ok, false)
    assert.equal(result.reason, agentAdapter ? 'unsupported-adapter' : 'no-adapter')
  }
  assert.deepEqual(calls, [])
})

test('a missing session id is refused before any request is sent', async () => {
  const calls = []
  const result = await locateRabiSender(config, { agentAdapter: 'codex', threadId: '  ' }, new AbortController().signal,
    manager({ onCall: () => calls.push('sent') }))
  assert.deepEqual(result, { ok: false, reason: 'no-thread', message: 'The message names no session id to locate.' })
  assert.deepEqual(calls, [])
})

test('an uncertain write keeps Rabi uncertainty flag so the row can say so', async () => {
  const result = await locateRabiSender(config, { agentAdapter: 'codex', threadId: 'task-1' }, new AbortController().signal,
    manager({ ok: false, statusCode: 503, body: { code: -1, message: 'Manager is restarting.' }, uncertain: true }))
  assert.equal(result.ok, false)
  assert.equal(result.uncertain, true)
})

test('a non-JSON Manager body still yields a stated failure rather than a crash', async () => {
  const result = await locateRabiSender(config, { agentAdapter: 'codex', threadId: 'task-1' }, new AbortController().signal, {
    managerRequest: async () => ({ statusCode: 500, ok: false, body: '<html>oops</html>', headers: {}, etag: '', uncertain: false, error: { kind: 'write_outcome_uncertain', message: 'connection reset' } }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.message, 'connection reset')
})

/** Drive the handler with one request and read its JSON reply, without a socket. */
async function callRoute(handler, { method = 'POST', url = LOCATE_AGENT_PATH, body } = {}) {
  const request = new (await import('node:stream')).Readable({ read() {} })
  request.method = method
  request.url = url
  const chunks = []
  const response = {
    // The handler subscribes to `close` to notice a client hang-up, so the double has
    // to carry the same surface a ServerResponse does.
    on() { return this },
    writableEnded: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(text) { chunks.push(text); this.writableEnded = true; this.done = true },
  }
  const promise = handler(request, response)
  if (body !== undefined) request.push(body)
  request.push(null)
  await promise
  return { statusCode: response.statusCode, payload: JSON.parse(chunks.join('') || '{}') }
}

test('the route answers a locate with the outcome as data and never throws at the browser', async () => {
  const handler = createLocateAgentHandler(config, manager())
  const { statusCode, payload } = await callRoute(handler, { body: JSON.stringify({ agentAdapter: 'codex', threadId: 'task-abc' }) })
  assert.equal(statusCode, 200)
  assert.equal(payload.code, 0)
  assert.equal(payload.data.ok, true)
  assert.equal(payload.data.owner, 'codex_desktop')
})

test('an unreachable Manager is reported as unreachable, not as a bad session', async () => {
  const handler = createLocateAgentHandler(config, {
    resolveManagerBase: async () => { throw new Error('Host has no active Manager URL.') },
  })
  const { statusCode, payload } = await callRoute(handler, { body: JSON.stringify({ agentAdapter: 'codex', threadId: 'task-abc' }) })
  assert.equal(statusCode, 200)
  assert.equal(payload.data.ok, false)
  assert.equal(payload.data.reason, 'unreachable')
  assert.match(payload.data.message, /no active Manager URL/)
})

test('a malformed body is a stated bad request and a wrong method is refused', async () => {
  const handler = createLocateAgentHandler(config, manager())
  const bad = await callRoute(handler, { body: '{not json' })
  assert.equal(bad.payload.data.reason, 'bad-request')
  const wrongMethod = await callRoute(handler, { method: 'GET' })
  assert.equal(wrongMethod.statusCode, 405)
})

/**
 * The route over a real HTTP server, with **no injected seams**.
 *
 * This is the only test that can catch a cancel bug, and it exists because one shipped:
 * watching the *request* stream's `close` fires as soon as the body is consumed, so every
 * locate aborted before the Manager was asked and the row reported "cancelled by the
 * client". Injected `resolveManagerBase`/`managerRequest` stubs ignore the abort signal,
 * which is exactly why the seam-based tests stayed green. The Manager here is a real HTTP
 * server too, so the abort signal has to be genuinely intact for the call to complete.
 */
test('over a real HTTP server the route answers a locate instead of cancelling itself', async () => {
  const managerServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    // `/meta` is checked for identity before any business call, so the fake Manager has
    // to be a well-formed Manager, not just an endpoint that returns the open receipt.
    if (req.url === '/meta') {
      res.end(JSON.stringify({ health: { state: 'healthy', live: true, requiredReady: true }, applicationGenerationId: 'gen-1', managerInstanceId: 'inst-1' }))
      return
    }
    res.end(JSON.stringify({ code: 0, action: 'open', threadId: 'task-abc', status: 'opened', owner: 'codex_desktop', thread: { title: 'Example' } }))
  })
  await new Promise(resolve => managerServer.listen(0, '127.0.0.1', resolve))
  const handler = createLocateAgentHandler({ managerBaseUrl: `http://127.0.0.1:${managerServer.address().port}` })
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    const response = await fetch(origin + LOCATE_AGENT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentAdapter: 'codex', threadId: 'task-abc' }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    // A self-cancelling handler would answer `unreachable` / "cancelled by the client" here.
    assert.equal(payload.data.ok, true, JSON.stringify(payload.data))
    assert.equal(payload.data.owner, 'codex_desktop')
    assert.equal((await fetch(origin + LOCATE_AGENT_PATH, { method: 'GET' })).status, 405)
  } finally {
    server.close()
    managerServer.close()
  }
})
