import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'

export function cleanBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '')
  if (!text) return ''
  const url = new URL(text)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('managerBaseUrl must be a complete HTTP(S) origin without credentials, path, query or fragment.')
  return url.origin
}

export function timeoutBudget(value) { return Math.min(120000, Math.max(1000, Math.floor(Number(value) || 30000))) }

async function hostStatus(config, signal) {
  const executable = String(config.hostExecutable || '').trim() || (process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'RabiRoute', 'RabiRouteHost.exe') : '')
  if (!executable) throw new Error('Configure hostExecutable or an explicit development managerBaseUrl; no Host discovery candidate is available.')
  await access(executable)
  return new Promise((resolve, reject) => execFile(executable, ['--command', 'status', '--json'], { windowsHide: true, encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, signal }, (error, stdout) => {
    if (error) return reject(new Error('RabiRoute Host status failed: ' + error.message))
    try { resolve(JSON.parse(stdout)) } catch { reject(new Error('RabiRoute Host returned invalid JSON.')) }
  }))
}

function identity(meta) {
  if (meta?.health?.state !== 'healthy' || meta?.health?.requiredReady !== true || typeof meta.applicationGenerationId !== 'string' || !meta.applicationGenerationId.trim() || typeof meta.managerInstanceId !== 'string' || !meta.managerInstanceId.trim()) throw new Error('RabiRoute Manager is not ready or has no generation/instance identity.')
  return { applicationGenerationId: meta.applicationGenerationId, managerInstanceId: meta.managerInstanceId }
}
function same(a, b) { return a.applicationGenerationId === b.applicationGenerationId && a.managerInstanceId === b.managerInstanceId }

/**
 * Resolve the Manager origin once for read-only UI work: the explicit config wins,
 * otherwise the Host reports it, and either way `/meta` must agree on identity.
 * This is the same authority `managerRequest` enforces per operation; it exists
 * separately so one panel read can make two requests after a single discovery.
 */
export async function resolveManagerBase(config, callerSignal, dependencies = {}) {
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
    if (descriptor && !same(observed, descriptor)) throw new Error('Host and Manager generation/instance identities do not match.')
    return base
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', abort)
  }
}

export async function managerRequest(config, pathname, init = {}, callerSignal, dependencies = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('RabiRoute operation timed out.')), timeoutBudget(config.requestTimeoutMs))
  const abort = () => controller.abort(callerSignal.reason)
  if (callerSignal?.aborted) abort()
  else callerSignal?.addEventListener('abort', abort, { once: true })
  const fetcher = dependencies.fetch || globalThis.fetch
  const request = async (url, options = {}) => {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12000)])
    const response = await fetcher(url, { ...options, signal, redirect: 'error' })
    const text = await response.text()
    let body
    try { body = text ? JSON.parse(text) : {} } catch { body = { text } }
    const headers = {}
    for (const name of ['etag', 'idempotency-key', 'retry-after']) {
      const value = response.headers.get(name)
      if (value !== null) headers[name] = value
    }
    return { statusCode: response.status, ok: response.ok && body?.code !== -1, body: JSON.stringify(body), headers, etag: headers.etag || '', parsed: body }
  }
  const metaAt = async base => {
    const result = await request(base + '/meta')
    if (!result.ok) throw new Error('Manager /meta HTTP ' + result.statusCode)
    return identity(result.parsed)
  }
  let base, before
  const method = String(init.method || 'GET').toUpperCase()
  const write = method !== 'GET'
  try {
    // Only discovery is retried. Even business GETs can update viewedAt.
    for (let attempt = 0; ; attempt++) {
      try {
        const explicit = cleanBaseUrl(config.managerBaseUrl)
        const descriptor = explicit ? null : await (dependencies.hostStatus || hostStatus)(config, controller.signal)
        base = explicit || cleanBaseUrl(descriptor?.managerBaseUrl)
        if (!base) throw new Error('Host has no active Manager URL.')
        before = await metaAt(base)
        if (descriptor && !same(before, descriptor)) throw new Error('Host and Manager generation/instance identities do not match.')
        break
      } catch (error) {
        if (attempt || write || controller.signal.aborted) throw error
      }
    }
    let result
    try {
      result = await request(base + pathname, { ...init, headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers } })
    } catch (error) {
      return { statusCode: 0, ok: false, body: '{}', headers: {}, etag: '', identity: before, uncertain: write, error: { kind: write ? 'write_outcome_uncertain' : 'request_failed', message: error.message + (write ? ' Keep the original request and idempotency key; read back before retrying.' : '') } }
    }
    delete result.parsed
    result.identity = before
    result.uncertain = write && result.statusCode >= 500
    if (!result.ok) result.error = { kind: result.uncertain ? 'write_outcome_uncertain' : 'manager_rejected', message: 'Manager HTTP ' + result.statusCode + '; inspect the original response body. No automatic replay was performed.' }
    if (write) {
      try {
        if (!same(before, await metaAt(base))) throw new Error('Manager identity changed after the write.')
      } catch (error) {
        result.ok = false
        result.uncertain = true
        result.error = { kind: 'write_outcome_uncertain', message: error.message + ' Original response retained; read back using the original key and body before retrying.' }
      }
    }
    return result
  } catch (error) {
    return { statusCode: 0, ok: false, body: '{}', headers: {}, etag: '', uncertain: false, error: { kind: 'connection_not_ready', message: error.message + ' No business request was sent; an old endpoint failure does not prove Manager is offline.' } }
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', abort)
  }
}
