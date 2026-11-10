/** HTTP, streaming and WebSocket adapters for the shared Rabi SDK; discovery owns operation contracts. */
import { managerRequest, resolveManagerBase, timeoutBudget } from './connection.js'
import { openApiWebSocket } from '../lib/operation-sdk.js'

/** Preserve the existing Manager origin/identity owner without reading another client's credentials. */
export function createOperationTransport(config = {}, dependencies = {}) {
  const request = async (method, target, options = {}) => {
    const mode = options.responseMode ?? 'text'
    if (!['text', 'bytes', 'stream'].includes(mode)) throw new TypeError('Unsupported operation response mode.')
    if (mode === 'stream' && typeof options.onChunk !== 'function') throw new TypeError('Stream response requires an explicit consumer.')
    const bodies = ['body', 'bodyText', 'bodyBytes', 'bodyStream'].filter(key => options[key] !== undefined)
    if (bodies.length > 1) throw new TypeError('Choose one operation request body representation.')
    if (options.maxResponseBytes !== undefined && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1)) throw new TypeError('maxResponseBytes must be a positive byte budget.')
    if (options.onResponse !== undefined && typeof options.onResponse !== 'function') throw new TypeError('onResponse must be a function.')
    const headers = { ...options.headers }
    const field = bodies[0]
    let body = field ? options[field] : undefined
    if (field === 'body' && typeof body !== 'string') body = JSON.stringify(body)
    if (field === 'bodyText') headers['content-type'] ??= 'text/plain; charset=utf-8'
    if (field === 'bodyBytes' || field === 'bodyStream') headers['content-type'] ??= 'application/octet-stream'
    return managerRequest(config, target, { method, headers, ...(body === undefined ? {} : { body }),
      ...(field === 'bodyStream' ? { duplex: 'half' } : {}), canonicalReceipt: true,
      responseMode: options.responseMode ?? 'text', onChunk: options.onChunk, onResponse: options.onResponse,
      maxResponseBytes: options.maxResponseBytes, timeoutMs: options.timeoutMs }, options.signal, dependencies)
  }
  const openWebSocket = async (target, options, contract, catalog) => {
    const base = await resolveManagerBase(config, options.signal, dependencies)
    const verifiedConfig = { ...config, managerBaseUrl: base }
    const verifyIdentity = async signal => {
      const receipt = await managerRequest(verifiedConfig, '/meta', { method: 'GET' }, signal, dependencies)
      let meta
      try { meta = JSON.parse(receipt.body) } catch { throw new Error('Manager returned invalid metadata before the WebSocket opened.') }
      if (meta?.data) meta = meta.data
      if (!receipt.ok || meta.applicationGenerationId !== catalog.applicationGenerationId || meta.managerInstanceId !== catalog.managerInstanceId) {
        throw Object.assign(new Error('Manager identity changed; retain the original stream request and inspect its state.'), { code: 'IDENTITY_CHANGED' })
      }
    }
    await verifyIdentity(options.signal)
    const url = new URL(target, base)
    if (url.origin !== base || url.username || url.password) throw new Error('Operation WebSocket requires the verified Manager origin.')
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return (dependencies.openApiWebSocket ?? openApiWebSocket)({ url, headers: { ...options.headers,
      'x-rabiroute-expected-application-generation-id': catalog.applicationGenerationId,
      'x-rabiroute-expected-manager-instance-id': catalog.managerInstanceId }, contract,
      onMessage: options.onMessage, onOpen: options.onOpen, onClose: options.onClose, signal: options.signal,
      protocols: options.protocols, maxMessageBytes: options.maxMessageBytes, maxBufferedBytes: options.maxBufferedBytes,
      drainOnRemoteClose: options.drainOnRemoteClose ?? false, timeoutMs: timeoutBudget(options.timeoutMs ?? config.requestTimeoutMs), verifyIdentity })
  }
  return { request, openWebSocket }
}
