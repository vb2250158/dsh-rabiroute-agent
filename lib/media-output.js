/** Thin Manager wire-to-host image presentation. Business contracts stay in Rabi. */
export const managerMediaSchema = {
  type: 'array', items: { type: 'object', properties: {
    type: { type: 'string', enum: ['image'] }, mimeType: { type: 'string' }, imageItemId: { type: 'string' },
    status: { type: 'string', enum: ['prepared', 'unavailable'] }, reason: { type: 'string' },
    width: { type: 'number' }, height: { type: 'number' }, frameId: { type: 'string' }, source: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
    transform: { type: 'object', additionalProperties: true },
    attachment: { type: 'object', properties: {
      attachmentId: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' },
      width: { type: 'number' }, height: { type: 'number' }, name: { type: 'string' },
      originalDimensions: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, additionalProperties: false },
    }, required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'], additionalProperties: false },
  }, required: ['type', 'imageItemId', 'status'], additionalProperties: false },
}

function declaredObject(body, pointer) {
  if (typeof pointer !== 'string' || pointer !== '' && !pointer.startsWith('/')) throw new Error('MEDIA_ENTRY_INVALID')
  let value = body
  for (const part of pointer === '' ? [] : pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/u.test(part)) throw new Error('MEDIA_ENTRY_INVALID')
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
    value = value[key]
  }
  return value
}

function summary(item, index) {
  const value = { type: 'image', imageItemId: typeof item?.imageItemId === 'string' && item.imageItemId.trim() ? item.imageItemId : 'image-' + (index + 1), status: 'unavailable' }
  for (const name of ['mimeType', 'frameId']) if (typeof item?.[name] === 'string') value[name] = item[name]
  if (typeof item?.source === 'string' || item?.source && typeof item.source === 'object' && !Array.isArray(item.source)) value.source = item.source
  for (const name of ['width', 'height']) if (Number.isSafeInteger(item?.[name]) && item[name] > 0) value[name] = item[name]
  if (item?.transform && typeof item.transform === 'object' && !Array.isArray(item.transform)) value.transform = item.transform
  return value
}

function encodedImage(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('IMAGE_OBJECT_REQUIRED')
  if (typeof item.mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/iu.test(item.mimeType)) throw new Error('IMAGE_MIME_TYPE_INVALID')
  if (typeof item.data !== 'string' || !item.data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.data)) throw new Error('IMAGE_BASE64_INVALID')
  if (['width', 'height'].some(key => item[key] !== undefined && (!Number.isSafeInteger(item[key]) || item[key] < 1))) throw new Error('IMAGE_DIMENSIONS_INVALID')
  const data = Buffer.from(item.data, 'base64')
  if (data.toString('base64') !== item.data) throw new Error('IMAGE_BASE64_INVALID')
  return { data, mediaType: item.mimeType }
}

function imageRoute(resolveLlm, exec) {
  const routed = exec.agent?.session.requestHeader()?.config
  return { llm: resolveLlm?.(), provider: routed?.provider ?? exec.agent?.options.provider, model: routed?.model ?? exec.agent?.options.model }
}

async function requestImageDimensions(route, attachments, ref, signal) {
  if (!route.provider || !route.model || typeof route.llm?.imageRequestTarget !== 'function' || typeof attachments.readImageRequest !== 'function') return ref
  let target
  try { target = await route.llm.imageRequestTarget(route.provider, route.model, ref) }
  catch (error) { if (error?.code === 'NO_ADAPTER') return ref; throw error }
  return attachments.readImageRequest(ref, target, signal)
}

const positiveDimension = value => Number.isSafeInteger(value) && value > 0

function captureImageView(item, dimensions) {
  const source = item.source
  if (!source || typeof source !== 'object' || Array.isArray(source) || source.coordinateSpace !== 'capture' ||
      !['desktop', 'window'].includes(source.kind) || ['instanceId', 'frameId', 'imageItemId'].some(key => typeof source[key] !== 'string' || !source[key]) ||
      !positiveDimension(source.width) || !positiveDimension(source.height) ||
      !Number.isFinite(source.bounds?.width) || source.bounds.width <= 0 || !Number.isFinite(source.bounds?.height) || source.bounds.height <= 0) return
  const before = source.imageView ?? source
  if (!positiveDimension(before.width) || !positiveDimension(before.height)) return
  if (before.width === dimensions.width && before.height === dimensions.height) return
  item.source = { ...source, imageView: { width: dimensions.width, height: dimensions.height } }
  const transform = item.transform ?? {}
  item.transform = { ...transform,
    ...(transform.scale && Number.isFinite(transform.scale.x) && Number.isFinite(transform.scale.y) ? {
      scale: { ...transform.scale, x: transform.scale.x * dimensions.width / before.width, y: transform.scale.y * dimensions.height / before.height },
    } : {}),
    scaleX: (Number.isFinite(transform.scaleX) ? transform.scaleX : before.width / source.bounds.width) * dimensions.width / before.width,
    scaleY: (Number.isFinite(transform.scaleY) ? transform.scaleY : before.height / source.bounds.height) * dimensions.height / before.height,
  }
}

/** Attach each declared image once. A presentation failure preserves the business receipt. */
export async function prepareManagerMedia(receipt, exec, dependencies = {}) {
  let body
  try { body = JSON.parse(receipt.body) } catch { return receipt }
  const declaration = Object.entries(receipt.headers ?? {}).find(([key]) => key.toLowerCase() === 'x-rabiroute-media')?.[1]
  const projected = declaration !== undefined && Array.isArray(receipt.media) ? receipt.media : undefined
  const contentType = Object.entries(receipt.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? ''
  const binary = /^image\//iu.test(contentType)
  if (!projected && declaration === undefined && !binary) return receipt
  // Parsing creates an isolated presentation copy. Existing transport callers retain raw responses.
  const media = [], inputs = [], inputIndexes = [], mediaErrors = [...(receipt.mediaErrors ?? [])]
  let bodyChanged = false
  const seen = new Map()
  let entries
  try {
    entries = declaration === undefined ? [] : JSON.parse(declaration)
    if (!Array.isArray(entries)) throw new Error('MEDIA_DECLARATION_INVALID')
  } catch {
    return { ...receipt, media: [], mediaErrors: [...mediaErrors, { code: 'MEDIA_DECLARATION_INVALID' }] }
  }
  const candidates = [], declaredImages = [], paths = new Set()
  if (projected) {
    for (const item of projected) if (item?.type === 'image') candidates.push({ ...item })
  }
  for (const [declarationIndex, entry] of entries.entries()) {
    if (entry?.type !== 'image' || paths.has(entry.path)) continue
    paths.add(entry.path)
    try {
      if (entry.matchMimeType !== undefined && (typeof entry.matchMimeType !== 'string' || entry.matchMimeType !== 'image/*' && !/^image\/[a-z0-9.+-]+$/iu.test(entry.matchMimeType))) throw new Error('MEDIA_ENTRY_INVALID')
      const item = declaredObject(body, entry.path)
      if (item === undefined) continue
      if (entry.matchMimeType !== undefined && (typeof item?.mimeType !== 'string' || (entry.matchMimeType === 'image/*' ? !/^image\//iu.test(item.mimeType) : item.mimeType.toLowerCase() !== entry.matchMimeType.toLowerCase()))) continue
      const encoded = encodedImage(item)
      declaredImages.push({ item, key: encoded.mediaType + ':' + encoded.data.toString('base64') })
      candidates.push({ ...item, imageItemId: summary(item, declarationIndex).imageItemId })
      delete item.data
      bodyChanged = true
    } catch (error) {
      const imageItemId = 'image-' + (declarationIndex + 1)
      media.push({ type: 'image', imageItemId, status: 'unavailable', reason: error.message })
      mediaErrors.push({ code: error.message, path: entry.path, imageItemId })
    }
  }
  if (binary) {
    const item = { mimeType: contentType.split(';')[0].trim().toLowerCase(), data: body.contentBase64 }
    try {
      encodedImage(item)
      candidates.push(item)
      delete body.contentBase64
      bodyChanged = true
    } catch (error) {
      mediaErrors.push({ code: error.message, imageItemId: 'image-1' })
    }
  }
  for (const candidate of candidates) {
    const item = summary(candidate, media.length)
    try {
      const input = encodedImage(candidate)
      const key = input.mediaType + ':' + input.data.toString('base64')
      if (seen.has(key)) continue
      seen.set(key, media.length)
      inputIndexes.push(media.length)
      inputs.push(input)
    } catch (error) { item.reason = error.message; mediaErrors.push({ code: error.message, imageItemId: item.imageItemId }) }
    media.push(item)
  }
  const result = { ...receipt, body: bodyChanged ? JSON.stringify(body) : receipt.body, media, ...(mediaErrors.length ? { mediaErrors } : {}) }
  const unavailable = reason => {
    for (const index of inputIndexes) media[index].reason = reason
    return result
  }
  if (!inputs.length) return result
  let attachments, route
  try {
    attachments = dependencies.resolveAttachments?.()
    if (!attachments) return unavailable('attachment_service_unavailable')
    route = imageRoute(dependencies.resolveLlm, exec)
  } catch { return unavailable('image_route_unavailable') }
  let refs
  try {
    // The public host store owns format, byte, pixel, per-message and normalization limits.
    refs = await attachments.saveImages(inputs)
  } catch (error) {
    return unavailable(typeof error?.code === 'string' ? error.code : 'attachment_save_failed')
  }
  for (const [offset, ref] of refs.entries()) {
    const index = inputIndexes[offset], item = media[index]
    try {
      // Resolve the same preview variant used by this exact model route's serializer.
      const dimensions = await requestImageDimensions(route, attachments, ref, exec.signal)
      if (!positiveDimension(dimensions.width) || !positiveDimension(dimensions.height)) throw new Error('IMAGE_PREVIEW_DIMENSIONS_INVALID')
      item.status = 'prepared'
      item.attachment = ref
      captureImageView(item, dimensions)
      item.width = dimensions.width
      item.height = dimensions.height
      for (const declared of declaredImages) if (seen.get(declared.key) === index) {
        captureImageView(declared.item, dimensions)
        declared.item.width = dimensions.width
        declared.item.height = dimensions.height
      }
    } catch (error) {
      item.reason = typeof error?.code === 'string' ? error.code : 'image_request_preview_failed'
      mediaErrors.push({ code: item.reason, imageItemId: item.imageItemId })
    }
  }
  if (bodyChanged) result.body = JSON.stringify(body)
  if (mediaErrors.length) result.mediaErrors = mediaErrors
  return result
}

/** Code Mode already handles image-bearing sub-results. Rendering adds no deferred event. */
export function renderManagerMedia(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) },
    ...(value.media ?? []).filter(item => item.status === 'prepared' && item.attachment)
      .map(item => ({ type: 'image', attachment: item.attachment }))]
}
