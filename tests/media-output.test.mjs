import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { internals, apply } from '../lib/index.js'
import { prepareManagerMedia } from '../lib/media-output.js'

// The real-host suite runs when its installed attachment backend is explicitly supplied.
const hostRoot = process.env.RABI_DSH_HOST_NODE_MODULES
const test = hostRoot ? nodeTest : nodeTest.skip
const { default: LocalAttachmentStore } = hostRoot ? await import(pathToFileURL(hostRoot + '/@deepseek-ai/dsh-attachment-local/lib/index.js')) : {}
const { Context } = hostRoot ? await import(pathToFileURL(hostRoot + '/@deepseek-ai/cordis/lib/index.js')) : {}
const { default: SystemPrompt } = hostRoot ? await import(pathToFileURL(hostRoot + '/@deepseek-ai/dsh-system-prompt/lib/index.js')) : {}
const { default: Tools } = hostRoot ? await import(pathToFileURL(hostRoot + '/@deepseek-ai/dsh-tools/lib/index.js')) : {}
const NativeExecutor = hostRoot ? await import(pathToFileURL(hostRoot + '/@deepseek-ai/dsh-tool-executor-native/lib/index.js')) : {}
const requireHost = hostRoot ? createRequire(hostRoot + '/@deepseek-ai/dsh-attachment-local/package.json') : undefined
const sharp = requireHost?.('sharp')
const png = hostRoot ? await sharp({ create: { width: 3, height: 2, channels: 4, background: '#2266aa' } }).png().toBuffer() : undefined
const png2 = hostRoot ? await sharp({ create: { width: 4, height: 3, channels: 4, background: '#aa6622' } }).png().toBuffer() : undefined
const image = data => ({ mimeType: 'image/png', data: data.toString('base64'), width: 999, height: 888, frameId: 'fixture-frame', source: 'test-fixture' })
const signal = () => new AbortController().signal
const exec = (nested = false) => ({ signal: signal(), agent: { options: { provider: 'fixture', model: 'vision' }, session: { requestHeader: () => ({ config: {} }) } }, control: { mode: nested ? 'nested' : 'ordinary', deferUserMessage() { assert.fail('Plugin must leave Code Mode image deferral to the host') } } })
const llm = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
const artifacts = new URL('../.test-media-artifacts/', import.meta.url)
await mkdir(artifacts, { recursive: true })
async function attachmentStore(t, config = {}) {
  const home = await mkdtemp(new URL('store-', artifacts).pathname.replace(/^\/(\w:)/, '$1'))
  const context = new Context()
  const store = new LocalAttachmentStore(context, { dshHome: home, ...config })
  t.after(() => context.fiber.dispose())
  return store
}
async function manager(t, payload, headers = {}, status = 200, binary = false) {
  const seen = []
  const server = createServer(async (req, res) => {
    // Keep the fixture's ephemeral port out of the shared fetch connection pool.
    res.setHeader('connection', 'close')
    seen.push({ path: req.url, method: req.method, headers: req.headers })
    if (req.url === '/meta') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ applicationGenerationId: 'generation', managerInstanceId: 'instance', health: { live: true, requiredReady: true, state: 'healthy' } }))
      return
    }
    for await (const _ of req) { /* Consume the real HTTP request body. */ }
    res.writeHead(status, { 'content-type': 'application/json', etag: '"fixture-v1"', 'x-rabiroute-request-id': 'request-fixture', ...headers })
    res.end(binary ? payload : JSON.stringify(payload))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { base: 'http://127.0.0.1:' + server.address().port, seen }
}
const tool = (base, dependencies = {}) => internals.toolDefinitions({ managerBaseUrl: base }, dependencies).find(item => item.name === 'rabiroute_manager_api')
const get = { method: 'GET', path: '/fixture/capture' }

test('official host registers media unions and native execution returns the image attachment', async t => {
  const store = await attachmentStore(t)
  const host = await manager(t, { code: 0, data: image(png) }, {
    'x-rabiroute-media': '[{"path":"/data","type":"image"}]',
  })
  const definition = tool(host.base, { resolveAttachments: () => store, resolveLlm: () => llm })
  const context = new Context()
  t.after(() => context.fiber.dispose())
  await context.plugin(SystemPrompt)
  await context.plugin(Tools)
  await context.plugin(NativeExecutor)
  const sourceSchema = definition.output.schema.properties.media.items.properties.source
  assert.equal(sourceSchema.oneOf.length, 2)
  const unsupported = structuredClone(definition.output.schema)
  unsupported.properties.media.items.properties.source = { anyOf: sourceSchema.oneOf }
  assert.throws(() => context.tools.register({ ...definition, name: 'unsupported_media_union',
    output: { ...definition.output, schema: unsupported },
  }), error => error.code === 'UNSUPPORTED_SCHEMA')
  context.tools.register(definition)
  const execution = exec()
  const agent = { ...execution.agent, id: 'media-tool-fixture', ctx: context }
  const batch = await context.tools.execute({
    calls: [{ type: 'tool-call', id: 'media-call', name: definition.name, arguments: JSON.stringify(get) }],
    agent, signal: execution.signal,
  })
  const result = batch.results[0].result
  assert.equal(result.isError, false)
  assert.deepEqual(result.content.map(block => block.type), ['text', 'image'])
  assert.deepEqual(Buffer.from((await store.readImage(result.content[1].attachment)).data), png)
})

for (const nested of [false, true]) test(`real HTTP + real attachments yields one image block (${nested ? 'nested' : 'ordinary'})`, async t => {
  const store = await attachmentStore(t)
  const payload = { code: 0, data: { capture: image(png), frameId: 'business-frame' }, actionExecuted: true }
  const host = await manager(t, payload, { 'x-rabiroute-media': JSON.stringify([{ path: '/data/capture', type: 'image' }]), 'idempotency-key': 'original-key' })
  let saves = 0
  const attachments = { saveImages: async images => { saves++; assert.equal(images.length, 1); return store.saveImages(images) } }
  const definition = tool(host.base, { resolveAttachments: () => attachments, resolveLlm: () => llm })
  const result = await definition.execute(get, exec(nested))
  assert.equal(result.ok, true)
  assert.equal(result.uncertain, false)
  assert.equal(result.etag, '"fixture-v1"')
  assert.equal(result.headers['idempotency-key'], 'original-key')
  assert.equal(result.headers['x-rabiroute-request-id'], 'request-fixture')
  assert.equal(JSON.parse(result.body).code, 0)
  assert.equal(JSON.parse(result.body).data.frameId, 'business-frame')
  assert.equal(result.media[0].status, 'prepared')
  assert.equal(result.media[0].width, 3)
  assert.equal(result.media[0].height, 2)
  assert.equal(result.media[0].frameId, 'fixture-frame')
  const blocks = definition.output.render(get, result)
  assert.deepEqual(blocks.map(block => block.type), ['text', 'image'])
  assert.equal(blocks[1].attachment.attachmentId, result.media[0].attachment.attachmentId)
  assert.doesNotMatch(blocks[0].text, new RegExp(png.toString('base64').slice(0, 36)))
  assert.deepEqual(Buffer.from((await store.readImage(blocks[1].attachment)).data), png)
  assert.equal(saves, 1)
  assert.deepEqual(host.seen.map(row => row.path), ['/meta', get.path])
  assert.deepEqual(definition.output.render(get, result), blocks)
  assert.equal(saves, 1, 'Rendering does not save or defer again')
})

test('ordinary nested business image-shaped fields remain byte-for-byte text without a declaration', async t => {
  const payload = { code: 0, data: { capture: image(png), value: 12 } }
  const host = await manager(t, payload)
  const definition = tool(host.base)
  const result = await definition.execute(get, exec())
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(result.body, JSON.stringify(payload))
  assert.equal(result.media, undefined)
  assert.deepEqual(definition.output.render(get, result), [{ type: 'text', text: JSON.stringify(result) }])
})

test('root-declared image is scrubbed while executed business status is retained when attachment service is absent', async t => {
  const host = await manager(t, { code: 0, data: image(png), actionExecuted: true }, { 'x-rabiroute-media': '[{"path":"/data","type":"image"}]' })
  const definition = tool(host.base)
  const result = await definition.execute({ ...get, method: 'POST', bodyJson: '{}' }, exec())
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(result.ok, true)
  assert.equal(result.uncertain, false)
  assert.equal(JSON.parse(result.body).actionExecuted, true)
  assert.equal(JSON.parse(result.body).data.data, undefined)
  assert.equal(result.media[0].reason, 'attachment_service_unavailable')
  assert.deepEqual(host.seen.map(row => row.path), ['/meta', get.path, '/meta'])
  assert.equal(host.seen[1].headers['x-rabiroute-expected-manager-instance-id'], 'instance')
  assert.equal(definition.output.render(get, result).length, 1)
})

test('outer projected media and matching header paths attach identical content only once', async t => {
  const store = await attachmentStore(t)
  const receipt = { statusCode: 200, ok: true, body: JSON.stringify({ code: 0, data: { capture: image(png) } }), media: [{ ...image(png), type: 'image', imageItemId: 'original-image-id' }], headers: { 'x-rabiroute-media': '[{"path":"/data/capture","type":"image"}]' } }
  const result = await prepareManagerMedia(receipt, exec(), { resolveAttachments: () => store, resolveLlm: () => llm })
  assert.equal(result.media.length, 1)
  assert.equal(result.media[0].imageItemId, 'original-image-id')
  assert.equal(result.media[0].status, 'prepared')
  assert.equal(JSON.parse(result.body).data.capture.data, undefined)
})
test('binary image HTTP response uses the same real attachment output', async t => {
  const store = await attachmentStore(t)
  const host = await manager(t, png, { 'content-type': 'image/png' }, 200, true)
  const definition = tool(host.base, { resolveAttachments: () => store, resolveLlm: () => llm })
  const result = await definition.execute(get, exec())
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(result.media[0].status, 'prepared')
  assert.equal(JSON.parse(result.body).contentBase64, undefined)
  assert.equal(result.media[0].width, 3)
})

test('host batch limit and decoder failures report media unavailable without rewriting business success', async t => {
  for (const [kind, images, policy] of [
    ['batch', [image(png), image(png2)], { maxImagesPerMessage: 1 }],
    ['decode', [{ mimeType: 'image/png', data: Buffer.from('not-an-image').toString('base64') }], {}],
  ]) {
    const store = await attachmentStore(t, policy)
    const receipt = { statusCode: 200, ok: true, uncertain: false, body: JSON.stringify({ code: 0, data: images }), headers: { 'x-rabiroute-media': JSON.stringify(images.map((_, index) => ({ path: '/data/' + index, type: 'image' }))) } }
    const result = await prepareManagerMedia(receipt, exec(), { resolveAttachments: () => store, resolveLlm: () => llm })
    assert.equal(result.ok, true, kind)
    assert.equal(result.uncertain, false, kind)
    assert.ok(result.media.every(item => item.status === 'unavailable' && item.reason), kind)
    assert.ok(result.media.every(item => !item.attachment), kind)
    assert.equal(result.body.includes(images[0].data), false, kind)
    assert.equal(JSON.parse(receipt.body).data[0].data, images[0].data, 'original receipt survives')
  }
})

test('invalid canonical base64 and malformed paths surface stable errors without an attachment write', async () => {
  const receipt = { statusCode: 200, ok: true, body: JSON.stringify({ data: { mimeType: 'image/png', data: 'Zh==' } }), headers: { 'x-rabiroute-media': '[{"path":"/data","type":"image"},{"path":"/~2","type":"image"}]' } }
  const result = await prepareManagerMedia(receipt, exec())
  assert.equal(result.ok, true)
  assert.deepEqual(new Set(result.media.map(item => item.reason)), new Set(['MEDIA_ENTRY_INVALID', 'IMAGE_BASE64_INVALID']))
  assert.equal(result.body, receipt.body)
  assert.equal(JSON.parse(result.body).data.data, 'Zh==')
  assert.ok(result.mediaErrors.some(item => item.code === 'IMAGE_BASE64_INVALID'))
})

for (const metadata of [{}, { inputModalities: ['text'] }]) test(`official host owns image projection for ${metadata.inputModalities ? 'explicit text-only' : 'unknown modality'} routes`, async t => {
  const store = await attachmentStore(t)
  const receipt = { statusCode: 200, ok: true, body: JSON.stringify({ data: image(png) }), headers: { 'x-rabiroute-media': '[{"path":"/data","type":"image"}]' } }
  let queries = 0
  const result = await prepareManagerMedia(receipt, exec(), { resolveAttachments: () => store, resolveLlm: () => ({ resolveModelInfo: async () => { queries++; return metadata } }) })
  assert.equal(queries, 0, 'The plugin leaves model capability and projection to the official host')
  assert.equal(result.media[0].status, 'prepared')
  assert.equal(result.media[0].reason, undefined)
  assert.ok(result.media[0].attachment)
})

test('plugin registers the same three tools when optional attachment and LLM services are absent', () => {
  const definitions = []
  const context = { tools: { register: item => definitions.push(item) }, systemPrompt: { section() {} }, on() {}, effect: fn => fn(), provide() {}, inject(names, callback) { if (names.every(name => name in this)) callback(this) } }
  assert.equal(apply(context, { planContextEnabled: false, planResourcesEnabled: false, agentHooksEnabled: false }).active, true)
  assert.deepEqual(definitions.map(item => item.name), ['rabiroute_agent_threads', 'rabiroute_agent_send', 'rabiroute_manager_api'])
})

test('duplicate declaration paths attach once without generating a spurious unavailable image', async t => {
  const store = await attachmentStore(t)
  const host = await manager(t, { data: image(png) }, { 'x-rabiroute-media': '[{"path":"/data","type":"image"},{"path":"/data","type":"image"}]' })
  const definition = tool(host.base, { resolveAttachments: () => store, resolveLlm: () => llm })
  const result = await definition.execute(get, exec())
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(result.media.length, 1)
  assert.equal(result.media[0].status, 'prepared')
})

test('image MIME mismatch and uncertain executed writes keep the original business outcome', async t => {
  const store = await attachmentStore(t)
  const badMime = { ...image(png), mimeType: 'image/jpeg' }
  const host = await manager(t, { code: -1, error: 'ACTION_STATUS_UNKNOWN', data: badMime }, { 'x-rabiroute-media': '[{"path":"/data","type":"image"}]' }, 503)
  const definition = tool(host.base, { resolveAttachments: () => store, resolveLlm: () => llm })
  const result = await definition.execute({ ...get, method: 'POST', bodyJson: '{}' }, exec())
  assert.equal(result.ok, false)
  assert.equal(result.uncertain, true)
  assert.equal(result.statusCode, 503)
  assert.equal(result.error.kind, 'write_outcome_uncertain')
  assert.equal(result.error.code, 'ACTION_STATUS_UNKNOWN')
  assert.equal(JSON.parse(result.body).code, -1)
  assert.equal(result.media[0].status, 'unavailable')
  assert.ok(result.media[0].reason)
  assert.equal(host.seen.filter(row => row.path === get.path).length, 1)
})

test('ordinary business media and contentType fields do not activate image interpretation', async t => {
  for (const payload of [
    { code: 0, media: [{ type: 'image', ...image(png) }] },
    { code: 0, contentType: 'image/png', contentBase64: png.toString('base64') },
  ]) {
    const host = await manager(t, payload)
    const definition = tool(host.base)
    const result = await definition.execute(get, exec())
    assert.equal(result.body, JSON.stringify(payload))
    assert.equal(result.media, undefined)
    assert.equal(definition.output.render(get, result).length, 1)
  }
})

test('invalid declared image fields retain the exact original business value', async () => {
  for (const payload of [
    { data: { mimeType: 'invoice/custom', data: 'business-value' } },
    { data: { mimeType: 'image/png', data: 'not-base64' } },
    { data: { mimeType: 'image/png', data: png.toString('base64'), width: 0 } },
  ]) {
    const receipt = { statusCode: 200, ok: true, body: JSON.stringify(payload, null, 2), headers: { 'x-rabiroute-media': '[{"path":"/data","type":"image"}]' } }
    const result = await prepareManagerMedia(receipt, exec())
    assert.equal(result.body, receipt.body)
    assert.equal(result.ok, true)
    assert.ok(result.mediaErrors.length)
    assert.equal(result.media[0].status, 'unavailable')
  }
})

test('distinct outer projected and declared images are both prepared', async t => {
  const store = await attachmentStore(t)
  const receipt = { statusCode: 200, ok: true, body: JSON.stringify({ data: image(png2) }), media: [{ ...image(png), type: 'image', imageItemId: 'projected-image' }], headers: { 'x-rabiroute-media': '[{"path":"/data","type":"image"}]' } }
  const result = await prepareManagerMedia(receipt, exec(), { resolveAttachments: () => store, resolveLlm: () => llm })
  assert.equal(result.media.length, 2)
  assert.deepEqual(result.media.map(item => [item.width, item.height, item.status]), [[3, 2, 'prepared'], [4, 3, 'prepared']])
  assert.notEqual(result.media[0].attachment.attachmentId, result.media[1].attachment.attachmentId)
})

test('conditional root and capture declarations skip unrelated results and missing paths without errors', async () => {
  const headers = { 'x-rabiroute-media': '[{"path":"/data","type":"image","matchMimeType":"image/*"},{"path":"/data/capture","type":"image","matchMimeType":"image/*"},{"path":"/optional-capture","type":"image"}]' }
  for (const payload of [{ code: 0, data: { file: 'fixture.txt', size: 17 } }, { code: 0, data: { windows: [] } }]) {
    const receipt = { statusCode: 200, ok: true, body: JSON.stringify(payload), headers }
    const result = await prepareManagerMedia(receipt, exec())
    assert.equal(result.body, receipt.body)
    assert.deepEqual(result.media, [])
    assert.equal(result.mediaErrors, undefined)
  }
})

test('conditional capture preserves transform and image identity through real host decoding', async t => {
  const store = await attachmentStore(t)
  const capture = { ...image(png), imageItemId: 'native-image-id', transform: { kind: 'crop', offsetX: 21, offsetY: 34, scale: { x: 1, y: 1 } } }
  const receipt = { statusCode: 200, ok: true, body: JSON.stringify({ data: { capture } }), headers: { 'x-rabiroute-media': '[{"path":"/data","type":"image","matchMimeType":"image/*"},{"path":"/data/capture","type":"image","matchMimeType":"image/png"}]' } }
  const result = await prepareManagerMedia(receipt, exec(), { resolveAttachments: () => store, resolveLlm: () => llm })
  assert.equal(result.media.length, 1)
  assert.equal(result.media[0].imageItemId, 'native-image-id')
  assert.deepEqual(result.media[0].transform, capture.transform)
  assert.equal(result.media[0].status, 'prepared')
  assert.equal(result.mediaErrors, undefined)
})

test('fallback image IDs retain declaration order when an earlier conditional path is skipped', async () => {
  const receipt = { statusCode: 200, ok: true, body: JSON.stringify({ data: { capture: image(png) } }), headers: { 'x-rabiroute-media': '[{"path":"/data","type":"image","matchMimeType":"image/*"},{"path":"/data/capture","type":"image","matchMimeType":"image/*"}]' } }
  const result = await prepareManagerMedia(receipt, exec())
  assert.equal(result.media.length, 1)
  assert.equal(result.media[0].imageItemId, 'image-2')
})


test('object capture source survives the media summary and official attachment output', async t => {
  const store = await attachmentStore(t)
  const source = {
    scope: 'region', displayId: 'display-two', frameId: 'source-frame', imageItemId: 'source-image',
    bounds: { x: -300, y: 20, width: 3, height: 2 },
    region: { x: 40, y: 20, width: 3, height: 2 },
    coordinateVariant: 'image', width: 3, height: 2,
  }
  const capture = { ...image(png), source, imageItemId: 'source-image' }
  const receipt = { statusCode: 200, ok: true, body: JSON.stringify({ code: 0, data: { capture, returnState: { cursor: 'restored' } } }),
    headers: { 'x-rabiroute-media': '[{"path":"/data/capture","type":"image"}]' } }
  const result = await prepareManagerMedia(receipt, exec(), { resolveAttachments: () => store, resolveLlm: () => llm })
  assert.equal(result.media[0].status, 'prepared')
  assert.deepEqual(result.media[0].source, source)
  assert.equal(result.media[0].imageItemId, source.imageItemId)
  assert.deepEqual(JSON.parse(result.body).data.capture.source, source)
  assert.deepEqual(JSON.parse(result.body).data.returnState, { cursor: 'restored' })
})

test('legacy string capture source remains available in the media summary', async t => {
  const store = await attachmentStore(t)
  const receipt = { statusCode: 200, ok: true, body: JSON.stringify({ data: image(png) }),
    headers: { 'x-rabiroute-media': '[{"path":"/data","type":"image"}]' } }
  const result = await prepareManagerMedia(receipt, exec(true), { resolveAttachments: () => store, resolveLlm: () => llm })
  assert.equal(result.media[0].status, 'prepared')
  assert.equal(result.media[0].source, 'test-fixture')
  assert.equal(JSON.parse(result.body).data.source, 'test-fixture')
})
const captureFixture = (data, width, height) => ({
  mimeType: 'image/png', data: data.toString('base64'), width, height,
  imageItemId: 'view-image', frameId: 'view-frame',
  source: { instanceId: 'view-computer', kind: 'desktop', scope: 'region', coordinateSpace: 'capture', coordinateVariant: 'image',
    width, height, frameId: 'view-frame', imageItemId: 'view-image',
    bounds: { x: -900, y: -100, width: width * 2, height: height * 2 } },
  transform: { viewport: { x: 0, y: 0, width: width * 2, height: height * 2 }, scaleX: 0.5, scaleY: 0.5, scale: { x: 0.5, y: 0.5 } },
});
const declaredCapture = capture => ({ body: JSON.stringify({ data: { capture } }),
  headers: { 'x-rabiroute-media': '[{"path":"/data/capture","type":"image"}]' } });

for (const [width, height, config, expected] of [
  [1920, 1080, { normalizedImageMaxDimension: 1024 }, [1024, 576]],
  [3840, 2160, {}, [2730, 1536]],
]) test(`real host normalization ${width}x${height} preserves frame identity and composes imageView`, async t => {
  const store = await attachmentStore(t, config);
  const data = await sharp({ create: { width, height, channels: 3, background: '#2266aa' } }).png().toBuffer();
  const capture = captureFixture(data, width, height), receipt = declaredCapture(capture);
  const result = await prepareManagerMedia(receipt, exec(), { resolveAttachments: () => store, resolveLlm: () => llm });
  const item = result.media[0], compact = JSON.parse(result.body).data.capture;
  const decoded = await sharp((await store.readImage(item.attachment)).data).metadata();
  assert.deepEqual([decoded.width, decoded.height], expected);
  for (const value of [item, compact]) {
    assert.deepEqual(value.source, { ...capture.source, imageView: { width: expected[0], height: expected[1] } });
    assert.deepEqual([value.width, value.height], expected);
    assert.equal(value.transform.scaleX, 0.5 * expected[0] / width);
    assert.equal(value.transform.scaleY, 0.5 * expected[1] / height);
    assert.equal(value.transform.scale.x, value.transform.scaleX);
    assert.equal(value.transform.scale.y, value.transform.scaleY);
    const bounds = value.source.bounds;
    assert.equal(bounds.x + expected[0] / 2 * bounds.width / value.source.imageView.width, -900 + width);
    assert.equal(bounds.y + expected[1] / 2 * bounds.height / value.source.imageView.height, -100 + height);
    assert.equal(value.source.width, width); assert.equal(value.source.height, height);
  }
  assert.equal(JSON.parse(receipt.body).data.capture.source.imageView, undefined);
  assert.equal(compact.data, undefined);
});

test('exact model request preview dimensions drive view coordinates while host attachment keeps saved dimensions', async t => {
  const store = await attachmentStore(t, { normalizedImageMaxDimension: 1024 });
  const data = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#2266aa' } }).png().toBuffer();
  const capture = captureFixture(data, 1920, 1080), receipt = declaredCapture(capture);
  let targets = 0, saves = 0, reads = 0;
  const route = { ...llm, imageRequestTarget(provider, model, ref) {
    targets++; assert.equal(provider, 'routed'); assert.equal(model, 'exact-model');
    assert.deepEqual([ref.width, ref.height], [1024, 576]);
    return { width: 512, height: 512, maxBytes: 1000000 };
  } };
  const attachments = {
    saveImages: async inputs => { saves++; return store.saveImages(inputs); },
    readImageRequest: async (...args) => { reads++; return store.readImageRequest(...args); },
  };
  const execution = exec(); execution.agent.session.requestHeader = () => ({ config: { provider: 'routed', model: 'exact-model' } });
  const result = await prepareManagerMedia(receipt, execution, { resolveAttachments: () => attachments, resolveLlm: () => route });
  const item = result.media[0], compact = JSON.parse(result.body).data.capture;
  assert.deepEqual([item.width, item.height], [512, 288]);
  assert.deepEqual(item.source.imageView, { width: 512, height: 288 });
  assert.deepEqual(compact.source, item.source);
  assert.deepEqual([item.attachment.width, item.attachment.height], [1024, 576]);
  assert.equal(item.source.width, 1920); assert.equal(item.source.height, 1080);
  assert.equal(item.transform.scaleX, 0.5 * 512 / 1920);
  const repeated = await store.readImageRequest(item.attachment, { width: 512, height: 512, maxBytes: 1000000 });
  assert.deepEqual([repeated.width, repeated.height], [512, 288]);
  assert.deepEqual([targets, saves, reads], [1, 1, 1]);
});

test('small capture images and resized legacy string sources keep their existing coordinate source', async t => {
  const store = await attachmentStore(t, { normalizedImageMaxDimension: 2 });
  const capture = captureFixture(png, 3, 2);
  const unchangedStore = await attachmentStore(t);
  const small = await prepareManagerMedia(declaredCapture(capture), exec(), { resolveAttachments: () => unchangedStore, resolveLlm: () => llm });
  assert.deepEqual(small.media[0].source, capture.source);
  assert.deepEqual(small.media[0].transform, capture.transform);
  const legacy = { ...capture, source: 'legacy-source' };
  const resized = await prepareManagerMedia(declaredCapture(legacy), exec(), { resolveAttachments: () => store, resolveLlm: () => llm });
  assert.equal(resized.media[0].source, 'legacy-source');
  assert.deepEqual(resized.media[0].transform, legacy.transform);
  assert.equal(JSON.parse(resized.body).data.capture.source, 'legacy-source');
});

test('preview failure stays local to one image and retains its business result and other attachments', async t => {
  const store = await attachmentStore(t);
  const receipt = { ok: true, uncertain: false, body: JSON.stringify({ data: [image(png), image(png2)], actionExecuted: true }),
    headers: { 'x-rabiroute-media': '[{"path":"/data/0","type":"image"},{"path":"/data/1","type":"image"}]' } };
  const attachments = { saveImages: inputs => store.saveImages(inputs), readImageRequest: async (ref, target, abort) => {
    if (ref.width === 3) throw Object.assign(new Error('fixture preview failed'), { code: 'FIXTURE_PREVIEW_FAILURE' });
    return store.readImageRequest(ref, target, abort);
  } };
  const route = { ...llm, imageRequestTarget: (_provider, _model, ref) => ({ width: ref.width, height: ref.height, maxBytes: 1000000 }) };
  const result = await prepareManagerMedia(receipt, exec(), { resolveAttachments: () => attachments, resolveLlm: () => route });
  assert.equal(result.ok, true); assert.equal(result.uncertain, false);
  assert.equal(JSON.parse(result.body).actionExecuted, true);
  assert.equal(result.media[0].status, 'unavailable'); assert.equal(result.media[0].reason, 'FIXTURE_PREVIEW_FAILURE');
  assert.equal(result.media[1].status, 'prepared'); assert.ok(result.media[1].attachment);
});

test('optional LLM service, missing current route and official NO_ADAPTER use saved attachment dimensions', async t => {
  const store = await attachmentStore(t)
  for (const resolveLlm of [undefined, () => ({ imageRequestTarget() { throw Object.assign(new Error('unregistered fixture route'), { code: 'NO_ADAPTER' }) } })]) {
    const result = await prepareManagerMedia(declaredCapture(captureFixture(png, 3, 2)), exec(), { resolveAttachments: () => store, resolveLlm })
    assert.equal(result.media[0].status, 'prepared')
    assert.deepEqual([result.media[0].width, result.media[0].height], [3, 2])
    assert.equal(result.media[0].source.imageView, undefined)
  }
  const execution = exec(); delete execution.agent.options.provider
  const result = await prepareManagerMedia(declaredCapture(captureFixture(png, 3, 2)), execution, { resolveAttachments: () => store,
    resolveLlm: () => ({ imageRequestTarget() { assert.fail('An absent route has no request target') } }) })
  assert.equal(result.media[0].status, 'prepared')
})
