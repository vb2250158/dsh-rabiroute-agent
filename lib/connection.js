import { readHostStatus as hostStatus, readManagerEndpoint } from './host-control.js'

export function cleanBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '')
  if (!text) return ''
  const url = new URL(text)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('managerBaseUrl must be a complete HTTP(S) origin without credentials, path, query or fragment.')
  return url.origin
}

export function timeoutBudget(value) { return Math.min(120000, Math.max(1000, Math.floor(Number(value) || 60000))) }

function identity(meta) {
  if (typeof meta?.applicationGenerationId !== 'string' || !meta.applicationGenerationId.trim() || typeof meta?.managerInstanceId !== 'string' || !meta.managerInstanceId.trim()) throw new Error('RabiRoute Manager has no valid generation/instance identity.')
  return { applicationGenerationId: meta.applicationGenerationId, managerInstanceId: meta.managerInstanceId }
}
function assertRequestReady(meta) {
  if (meta?.health?.live !== true || meta?.health?.requiredReady !== true || !['healthy', 'degraded'].includes(meta?.health?.state)) throw new Error('RabiRoute Manager is not live and required-ready, or reported an invalid health state.')
}
function same(a, b) { return a.applicationGenerationId === b.applicationGenerationId && a.managerInstanceId === b.managerInstanceId }

/**
 * Resolve the Manager origin once for read-only UI work: the explicit config wins,
 * otherwise the Host reports it, and either way `/meta` must agree on identity.
 * This is the same authority `managerRequest` enforces per operation; it exists
 * separately so one panel read can make two requests after a single discovery.
 * Speech may opt into a live degraded Manager with required capabilities ready;
 * it separately checks speech readiness and does not depend on plan storage.
 */
export async function resolveManagerBase(config, callerSignal, dependencies = {}, { allowDegraded = false } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('RabiRoute Manager discovery timed out.')), 3000)
  const abort = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) abort()
  else callerSignal?.addEventListener('abort', abort, { once: true })
  try {
    const fetcher = dependencies.fetch || globalThis.fetch
    const explicit = cleanBaseUrl(config.managerBaseUrl)
    const descriptor = explicit ? null : await (dependencies.hostStatus || hostStatus)(config, controller.signal)
    const base = explicit || cleanBaseUrl(descriptor?.managerBaseUrl)
    if (!base) throw new Error('Host has no active Manager URL.')
    const response = await fetcher(base + '/meta', { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } })
    const text = await response.text()
    if (!response.ok) throw new Error('Manager /meta HTTP ' + response.status)
    let meta
    try { meta = JSON.parse(text) } catch { throw new Error('Manager /meta returned invalid JSON.') }
    const observed = identity(meta)
    assertRequestReady(meta)
    if (descriptor && !same(observed, descriptor)) throw new Error('Host and Manager generation/instance identities do not match.')
    return base
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', abort)
  }
}

function isReadOnlyThreadPost(pathname, method, body) {
  if (method !== 'POST' || pathname !== '/api/agent/threads' || typeof body !== 'string') return false
  try {
    const request = JSON.parse(body)
    return request !== null && typeof request === 'object' && !Array.isArray(request) && ['list', 'read'].includes(request.action)
  } catch { return false }
}

export async function managerRequest(config, pathname, init = {}, callerSignal, dependencies = {}) {
  const started = performance.now()
  const timed = async (path, task) => {
    const start = performance.now()
    let failed = false
    try { return await task() }
    catch (error) { failed = true; throw error }
    finally { dependencies.onTiming?.({ path, startMs: start - started, durationMs: performance.now() - start, ...(failed ? { failed } : {}) }) }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('RabiRoute operation timed out.')), timeoutBudget(config.requestTimeoutMs))
  const abort = () => controller.abort(callerSignal.reason)
  if (callerSignal?.aborted) abort()
  else callerSignal?.addEventListener('abort', abort, { once: true })
  const fetcher = dependencies.fetch || globalThis.fetch
  const request = async (url, options = {}) => {
    const response = await fetcher(url, { ...options, signal: controller.signal, redirect: 'error' })
    let body
    const contentType = response.headers.get('content-type') || ''
    if (contentType && !/^(?:text\/|application\/(?:[^;]+\+)?json\b|application\/(?:xml|javascript|x-www-form-urlencoded)\b)/i.test(contentType)) {
      body = { contentType, contentBase64: Buffer.from(await response.arrayBuffer()).toString('base64') }
    } else {
      const text = await response.text()
      try { body = text ? JSON.parse(text) : {} } catch { body = { text } }
    }
    const headers = Object.fromEntries(response.headers)
    return { statusCode: response.status, ok: response.ok && body?.code !== -1, body: JSON.stringify(body), headers, etag: headers.etag || '', parsed: body }
  }
  const metaAt = async (base, phase) => {
    const result = await timed([phase], () => request(base + '/meta'))
    if (!result.ok) throw new Error('Manager /meta HTTP ' + result.statusCode)
    return { result, identity: identity(result.parsed) }
  }
  let base, before, observedMeta, localDirect = false
  const method = String(init.method || 'GET').toUpperCase()
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method) && !isReadOnlyThreadPost(pathname, method, init.body)
  const diagnostic = method === 'GET' && pathname === '/meta'
  try {
    // Only discovery is retried. Even business GETs can update viewedAt.
    for (let attempt = 0; ; attempt++) {
      let usedHint = false
      try {
        const explicit = cleanBaseUrl(config.managerBaseUrl)
        const hintReader = dependencies.endpointHint ?? (dependencies.hostStatus ? async () => null : readManagerEndpoint)
        const hint = explicit || attempt ? null : await timed(['endpoint-hint'], () => hintReader(config, controller.signal))
        usedHint = hint !== null
        const descriptor = explicit ? null : hint ?? await timed(['host-discovery'], () => (dependencies.hostStatus || hostStatus)(config, controller.signal))
        base = explicit || cleanBaseUrl(descriptor?.managerBaseUrl)
        if (descriptor?.state === 'stopped') throw Object.assign(new Error('Rabi is not running. Start Rabi, then send your message again.'), { kind: 'host_stopped' })
        if (!base) throw new Error('Host has no active Manager URL.')
        localDirect = config.localAgentUnrestricted === true && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)
        if (localDirect && !diagnostic) {
          before = descriptor ? identity(descriptor) : undefined
          break
        }
        observedMeta = await metaAt(base, 'manager-meta-before')
        before = observedMeta.identity
        if (descriptor && !same(before, descriptor)) throw new Error('Host and Manager generation/instance identities do not match.')
        if (!diagnostic) assertRequestReady(observedMeta.result.parsed)
        break
      } catch (error) {
        if (attempt || write && !usedHint || controller.signal.aborted) throw error
      }
    }
    if (diagnostic) {
      const result = observedMeta.result
      delete result.parsed
      return { ...result, identity: before, uncertain: false }
    }
    let result
    try {
      // Every mutation carries the identity verified immediately before dispatch.
      const fence = write && before ? {
        'x-rabiroute-expected-application-generation-id': before.applicationGenerationId,
        'x-rabiroute-expected-manager-instance-id': before.managerInstanceId,
      } : {}
      const requestStarted = performance.now() - started
      result = await timed(['manager-request'], () => request(base + pathname, { ...init, headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers, ...fence } }))
      // Server offsets use the server's own monotonic clock, aligned to request dispatch.
      // Network/serialization time remains attributed to the enclosing request.
      if (pathname === '/api/codex-hook/context' && Array.isArray(result.parsed?.data?.timings)) {
        const elapsed = performance.now() - started - requestStarted
        for (const item of result.parsed.data.timings.slice(0, 64)) {
          if (typeof item?.name !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/u.test(item.name)
            || !Number.isFinite(item.startMs) || !Number.isFinite(item.durationMs) || item.startMs < 0 || item.durationMs < 0
            || item.startMs + item.durationMs > elapsed) continue
          dependencies.onTiming?.({ path: ['manager-request', item.name], startMs: requestStarted + item.startMs, durationMs: item.durationMs })
        }
      }
    } catch (error) {
      return { statusCode: 0, ok: false, body: '{}', headers: {}, etag: '', identity: before, uncertain: write, error: { kind: write ? 'write_outcome_uncertain' : 'request_failed', message: error.message + (write ? ' Keep the original request and idempotency key; read back before retrying.' : '') } }
    }
    const rejectedBeforeStart = method === 'POST' && pathname === '/api/codex-hook/context'
      && result.statusCode === 503 && result.parsed?.error === 'PLAN_STORAGE_STARTUP_UNAVAILABLE'
      && result.parsed?.commitState === 'not_started'
    const rejectionCode = typeof result.parsed?.error === 'string' ? result.parsed.error : undefined
    const rejectionCause = typeof result.parsed?.message === 'string' ? result.parsed.message.trim().slice(0, 1000) : ''
    delete result.parsed
    result.identity = before
    result.uncertain = write && result.statusCode >= 500 && !rejectedBeforeStart
    if (!result.ok) result.error = { kind: result.uncertain ? 'write_outcome_uncertain' : 'manager_rejected', ...(rejectionCode ? { code: rejectionCode } : {}), message: 'Manager HTTP ' + result.statusCode + (rejectionCause ? ': ' + rejectionCause : '; inspect the original response body.') + ' No automatic replay was performed.' }
    if (write && !localDirect) {
      try {
        if (!same(before, (await metaAt(base, 'manager-meta-after')).identity)) throw new Error('Manager identity changed after the write.')
      } catch (error) {
        result.ok = false
        result.uncertain = true
        result.error = { kind: 'write_outcome_uncertain', message: error.message + ' Original response retained; read back using the original key and body before retrying.' }
      }
    }
    return result
  } catch (error) {
    return { statusCode: 0, ok: false, body: '{}', headers: {}, etag: '', uncertain: false, error: { kind: error.kind === 'host_stopped' ? 'host_stopped' : 'connection_not_ready', message: error.message + ' No business request was sent; an old endpoint failure does not prove Manager is offline.' } }
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', abort)
  }
}
