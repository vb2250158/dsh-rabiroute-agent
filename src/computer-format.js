import { computerRequestUsesImageView, computerRequestSchemaSupportsImageView } from './vendor/computer-image-view.mjs'

const operationId = 'manager.lan-agent.computer.execute'
const operationPath = '/api/agent/operations/' + operationId + '?view=input'
const proxyGetPath = '/api/agent/operations/manager.rabilink.peer.http.get?view=full'
const caches = new WeakMap()

function requestTarget(method, pathname, body) {
  if (method !== 'POST') return
  const path = pathname.split('?')[0]
  let prefix = ''
  if (!/^\/api\/lan-agent\/instances\/[^/]+\/computer$/.test(path)) {
    const peer = /^\/api\/rabilink\/peer\/http\/([^/]+)\/([^/]+)\/(.+)$/.exec(path)
    if (!peer) return
    try {
      if (decodeURIComponent(peer[2]) !== 'manager') return
      const rawInner = '/' + peer[3].replace(/^\/+/, '')
      const inner = '/' + peer[3].split('/').map(decodeURIComponent).join('/').replace(/^\/+/, '')
      if (!/^\/api\/lan-agent\/instances\/[^/]+\/computer$/.test(rawInner)
        && !/^\/api\/lan-agent\/instances\/[^/]+\/computer$/.test(inner)) return
      prefix = '/api/rabilink/peer/http/' + peer[1] + '/' + peer[2]
    } catch { return /* The original route owner reports malformed escaping. */ }
  }
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) return
  let value
  try { value = JSON.parse(typeof body === 'string' ? body : body.toString('utf8')) } catch { return }
  if (computerRequestUsesImageView(value?.action, value)) return { prefix, body: value }
}

function metadataIdentity(meta) {
  if (typeof meta?.applicationGenerationId !== 'string' || !meta.applicationGenerationId.trim()
    || typeof meta?.managerInstanceId !== 'string' || !meta.managerInstanceId.trim()) {
    throw new Error('The target did not return its Manager identity.')
  }
  const revision = meta.apiTransport?.metadataRevision
  return [meta.applicationGenerationId, meta.managerInstanceId, typeof revision === 'string' && revision.trim() ? revision : '']
}

function operationDescription(receipt, expectedId) {
  const data = receipt.parsed?.data
  const entry = data?.operation ?? data?.operations?.find(item => item.id === expectedId)
  if (!receipt.ok || receipt.parsed?.code !== 0 || entry?.id !== expectedId || typeof entry.contractDigest !== 'string') {
    throw new Error('The target operation input contract could not be confirmed.')
  }
  return { data, entry, contract: entry.contract ?? entry }
}

async function readOperation(read, prefix, path, headers, expectedId) {
  let receipt = await read(prefix + path, { method: 'GET', headers })
  if (receipt.statusCode === 404) {
    receipt = await read(prefix + '/api/agent/help?operationId=' + encodeURIComponent(expectedId), { method: 'GET', headers })
  }
  return operationDescription(receipt, expectedId)
}

function cacheFor(config) {
  let cache = caches.get(config)
  if (!cache) { cache = new Map(); caches.set(config, cache) }
  return cache
}

function metadataHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) =>
    !['x-rabiroute-api-contract', 'x-rabiroute-proxy-contract', 'if-match', 'idempotency-key', 'content-length'].includes(key.toLowerCase())))
}

/** Confirm only the receiver format required by a resized-image coordinate write. */
export function checkComputerImageView(options) {
  const target = requestTarget(options.method, options.pathname, options.init.body)
  if (target) return confirmComputerImageView(options, target)
}

async function confirmComputerImageView({ config, base, init, meta, read }, target) {
  const cache = cacheFor(config)
  try {
    const readMeta = async (path, headers) => {
      const receipt = await read(path, { method: 'GET', headers })
      if (!receipt.ok) throw new Error('The target Manager metadata could not be read.')
      return receipt.parsed
    }
    let headers = { ...metadataHeaders(init.headers), accept: 'application/json' }
    const localMeta = meta ?? await readMeta('/meta', headers)
    const localIdentity = metadataIdentity(localMeta)
    if (target.prefix) {
      const proxyKey = JSON.stringify([base, 'proxy-get'])
      const identityKey = JSON.stringify(localIdentity)
      let cached = cache.get(proxyKey)
      if (!localIdentity[2] || cached?.identityKey !== identityKey) {
        const description = await readOperation(read, '', proxyGetPath, headers, 'manager.rabilink.peer.http.get')
        if (description.data.applicationGenerationId !== localIdentity[0] || description.data.managerInstanceId !== localIdentity[1]) {
          throw new Error('The proxy GET contract belongs to a changed Manager identity.')
        }
        cached = { identityKey, description }
        cache.set(proxyKey, cached)
      }
      headers['x-rabiroute-proxy-contract'] = cached.description.entry.contractDigest
      for (const [name, value] of Object.entries(init.headers ?? {})) {
        if (name.toLowerCase() === 'x-rabiroute-target-headers') {
          const original = JSON.parse(value)
          headers[name] = JSON.stringify(metadataHeaders(original))
        }
      }
    }
    const targetMeta = target.prefix ? await readMeta(target.prefix + '/meta', headers) : localMeta
    const receiverIdentity = metadataIdentity(targetMeta)
    const key = JSON.stringify([base, target.prefix])
    const identityKey = JSON.stringify([...localIdentity, ...receiverIdentity])
    let cached = cache.get(key)
    if (!localIdentity[2] || !receiverIdentity[2] || cached?.identityKey !== identityKey) {
      const description = await readOperation(read, target.prefix, operationPath, headers, operationId)
      if (description.data.applicationGenerationId !== receiverIdentity[0] || description.data.managerInstanceId !== receiverIdentity[1]) {
        throw new Error('The target operation contract belongs to a changed Manager identity.')
      }
      cached = { identityKey, description }
      cache.set(key, cached)
    }
    const schema = cached.description.contract.request?.body?.schema
    if (computerRequestSchemaSupportsImageView(schema, target.body.action)) return
    return failure(target, 'COMPUTER_IMAGE_VIEW_UNSUPPORTED', 'The target input contract does not declare resized-image coordinates.')
  } catch (error) {
    return failure(target, 'COMPUTER_IMAGE_VIEW_UNCONFIRMED', error.message)
  }
}

function failure(target, code, reason) {
  const width = target.body.source?.imageView?.width
  const message = reason + ' Capture the same display or region again with maxWidth=' + width
    + ', inspect the new image and use its new source, or update the target computer receiver. The coordinate request was not sent.'
  const recovery = target.body.action === 'input.execute'
    ? ' Read input.status with the original requestId to reconcile an existing receipt.'
    : ' Read the original annotation layer or tracking status to reconcile an existing receipt.'
  const body = { code: -1, error: code, message: message + recovery, dispatchState: 'not_sent', originalReceipt: 'not_checked', operationId }
  return { statusCode: 400, ok: false, body: JSON.stringify(body), headers: {}, etag: '', uncertain: false,
    error: { kind: 'computer_image_view_format', code, message: body.message } }
}
