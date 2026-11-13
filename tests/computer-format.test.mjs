import assert from 'node:assert/strict'
import test from 'node:test'
import { managerRequest } from '../lib/connection.js'
import { checkComputerImageView } from '../lib/computer-format.js'

const path = '/api/lan-agent/instances/fixture/computer'
const operationId = 'manager.lan-agent.computer.execute'
const source = { instanceId: 'fixture', kind: 'desktop', coordinateSpace: 'capture', frameId: 'frame', imageItemId: 'image',
  width: 1920, height: 1080, imageView: { width: 512, height: 288 } }
const click = () => ({ action: 'input.execute', requestId: 'original', controlSessionId: 'control', source: structuredClone(source),
  actions: [{ type: 'click', x: 256, y: 144 }] })
const schema = supported => ({ anyOf: ['input.execute', 'annotation.show', 'annotation.update', 'annotation.track.start'].map(action => ({
  type: 'object', properties: { action: { const: action }, source: { type: 'object', additionalProperties: true,
    properties: supported ? { imageView: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } } } } : {} } },
})) })

function fixture({ supported = false, peerSupported = supported, failContract = false, legacy = false, localDirect = true } = {}) {
  const calls = []
  const config = { managerBaseUrl: 'http://localhost:12345', localAgentUnrestricted: localDirect }
  const state = { revision: 'revision-1', remoteRevision: 'remote-1', supported, peerSupported }
  const meta = remote => ({ applicationGenerationId: remote ? 'remote-generation' : 'generation', managerInstanceId: remote ? 'remote-manager' : 'manager',
    apiTransport: { metadataRevision: remote ? state.remoteRevision : state.revision }, pluginGeneration: { id: 'unchanged-plugin' }, health: { live: true, requiredReady: true, state: 'healthy' } })
  const fetch = async (url, init) => {
    const address = new URL(url), remote = address.pathname.startsWith('/api/rabilink/peer/http/remote/manager/')
    const targetPath = remote ? address.pathname.slice('/api/rabilink/peer/http/remote/manager'.length) : address.pathname
    calls.push({ path: address.pathname + address.search, method: init.method ?? 'GET', headers: init.headers, body: init.body })
    if (targetPath === '/meta') return Response.json(meta(remote))
    const proxyOperation = targetPath.includes('manager.rabilink.peer.http.get')
    if (targetPath.startsWith('/api/agent/operations/') || targetPath === '/api/agent/help') {
      if (failContract) return Response.json({ code: -1 }, { status: 503 })
      if (legacy && targetPath.startsWith('/api/agent/operations/')) return Response.json({ code: -1 }, { status: 404 })
      const operation = proxyOperation ? { id: 'manager.rabilink.peer.http.get', contractDigest: 'proxy-get-digest', contract: {
        method: 'GET', pathTemplate: '/api/rabilink/peer/http/:deviceId/:service/:path', request: { body: { kind: 'passthrough' } },
      } } : { id: operationId, contractDigest: 'computer-digest', request: { body: { kind: 'json', schema: schema(remote ? state.peerSupported : state.supported) } } }
      const { applicationGenerationId, managerInstanceId } = meta(remote)
      return Response.json({ code: 0, data: { applicationGenerationId, managerInstanceId,
        ...(targetPath === '/api/agent/help' ? { operations: [operation] } : { operation }) } })
    }
    return Response.json({ code: 0, data: { state: 'completed' } })
  }
  const run = (body, target = path, headers = {}) => managerRequest(config, target,
    { method: 'POST', body: Buffer.isBuffer(body) ? body : JSON.stringify(body), headers }, new AbortController().signal, { fetch })
  return { calls, state, run }
}

test('old receiver with additionalProperties cannot accept scaled coordinates and no business write is sent', async () => {
  const { calls, run } = fixture()
  const body = click(), original = JSON.stringify(body)
  const result = await run(body)
  assert.equal(result.statusCode, 400)
  assert.equal(result.error.code, 'COMPUTER_IMAGE_VIEW_UNSUPPORTED')
  assert.equal(result.uncertain, false)
  assert.equal(JSON.parse(result.body).originalReceipt, 'not_checked')
  assert.equal(JSON.parse(result.body).commitState, undefined)
  assert.equal(JSON.parse(result.body).dispatchState, 'not_sent')
  assert.match(result.error.message, /maxWidth=512/)
  assert.equal(calls.some(call => call.method === 'POST'), false)
  assert.equal(JSON.stringify(body), original)
})

test('new receiver gets the original bytes and contract reads are reused until actual metadata changes', async () => {
  const { calls, state, run } = fixture({ supported: true })
  const body = click(), headers = { authorization: 'fixture-auth', 'idempotency-key': 'original-key' }
  for (let index = 0; index < 2; index++) assert.equal((await run(body, path, headers)).ok, true)
  assert.equal(calls.filter(call => call.path.includes('/operations/')).length, 1)
  const writes = calls.filter(call => call.method === 'POST')
  assert.equal(writes.length, 2)
  assert.equal(writes[0].body, JSON.stringify(body))
  assert.equal(writes[0].headers['idempotency-key'], 'original-key')
  assert.equal(calls.find(call => call.path.includes('/operations/')).headers.authorization, 'fixture-auth')
  assert.equal(calls.find(call => call.path.includes('/operations/')).headers['idempotency-key'], undefined)
  state.revision = 'revision-2'
  state.supported = false
  assert.equal((await run(body)).error.code, 'COMPUTER_IMAGE_VIEW_UNSUPPORTED')
  assert.equal(calls.filter(call => call.path.includes('/operations/')).length, 2)
  assert.equal(calls.filter(call => call.method === 'POST').length, 2)
})

test('text, keys, equal-size views, desktop coordinates, recovery and unrelated APIs keep the direct-call budget', async () => {
  const { calls, run } = fixture({ failContract: true })
  const values = [
    { ...click(), actions: [{ type: 'text', text: 'fixture' }, { type: 'key', keys: ['ENTER'] }] },
    { ...click(), actions: [{ type: 'scroll', deltaY: 1 }] },
    { ...click(), source: { ...source, imageView: { width: 1920, height: 1080 } } },
    { ...click(), source: { ...source, coordinateSpace: 'desktop', frameId: undefined } },
    { ...click(), actions: [{ type: 'scroll', x: 20, deltaY: 1 }] },
    { ...click(), actions: [{ type: 'scroll', y: 20, deltaY: 1 }] },
    { action: 'input.cancel', requestId: 'original' }, { action: 'control.status' }, { action: 'screen.capture' },
    { action: 'annotation.clear' }, { action: 'file.stat', path: 'fixture' },
  ]
  for (const body of values) assert.equal((await run(body)).ok, true)
  assert.equal((await run(click(), '/api/future-feature/execute')).ok, true)
  assert.equal(calls.length, values.length + 1)
  assert.equal(calls.every(call => call.method === 'POST'), true)
})

test('verification reuses discovered meta and only explicit 404 enables legacy contract lookup', async () => {
  const { calls, run } = fixture({ supported: true, legacy: true, localDirect: false })
  assert.equal((await run(click())).ok, true)
  assert.deepEqual(calls.map(call => call.path), ['/meta', '/api/agent/operations/' + operationId + '?view=input',
    '/api/agent/help?operationId=' + operationId, path, '/meta'])
  const unavailable = fixture({ failContract: true })
  assert.equal((await unavailable.run(click())).error.code, 'COMPUTER_IMAGE_VIEW_UNCONFIRMED')
  assert.equal(unavailable.calls.some(call => call.path.includes('/help')), false)
  assert.equal(unavailable.calls.some(call => call.method === 'POST'), false)
})

test('peer format comes from the actual remote Manager and uses the current GET proxy contract', async () => {
  const { calls, state, run } = fixture({ supported: true, peerSupported: false })
  const target = '/api/rabilink/peer/http/remote/manager' + path
  const headers = { 'x-rabiroute-proxy-contract': 'original-post-digest', 'x-rabiroute-target-headers':
    JSON.stringify({ 'x-fixture-context': 'target-context', 'x-rabiroute-api-contract': 'original-computer-digest', 'idempotency-key': 'original-key' }) }
  assert.equal((await run(click(), target, headers)).error.code, 'COMPUTER_IMAGE_VIEW_UNSUPPORTED')
  const remoteReads = calls.filter(call => call.path.startsWith('/api/rabilink/peer/http/'))
  assert.equal(remoteReads.length, 2)
  assert.equal(remoteReads.every(call => call.method === 'GET'), true)
  assert.equal(remoteReads.every(call => call.headers['x-rabiroute-proxy-contract'] === 'proxy-get-digest'), true)
  assert.deepEqual(JSON.parse(remoteReads[0].headers['x-rabiroute-target-headers']), { 'x-fixture-context': 'target-context' })
  state.remoteRevision = 'remote-2'
  state.peerSupported = true
  assert.equal((await run(click(), target, headers)).ok, true)
  const write = calls.find(call => call.method === 'POST')
  assert.equal(write.headers['x-rabiroute-proxy-contract'], 'original-post-digest')
  assert.equal(write.headers['x-rabiroute-target-headers'], headers['x-rabiroute-target-headers'])
  assert.equal(write.body, JSON.stringify(click()))
})

for (const action of ['annotation.show', 'annotation.update', 'annotation.track.start']) {
  test(action + ' uses the same shared scaled-view receiver check', async () => {
    const { calls, run } = fixture()
    assert.equal((await run({ action, source, objects: [], targets: [] })).error.code, 'COMPUTER_IMAGE_VIEW_UNSUPPORTED')
    assert.equal(calls.some(call => call.method === 'POST'), false)
  })
}

test('a cached frame does not become desktop coordinates when the caller changes the marker', async () => {
  const { calls, run } = fixture()
  const body = click()
  body.source.coordinateSpace = 'desktop'
  assert.equal((await run(body)).error.code, 'COMPUTER_IMAGE_VIEW_UNSUPPORTED')
  assert.equal(calls.some(call => call.method === 'POST'), false)
})

test('a receiver without a metadata revision re-reads its contract before another scaled write', async () => {
  const { calls, state, run } = fixture({ supported: true })
  state.revision = undefined
  assert.equal((await run(click())).ok, true)
  state.supported = false
  assert.equal((await run(click())).error.code, 'COMPUTER_IMAGE_VIEW_UNSUPPORTED')
  assert.equal(calls.filter(call => call.path.includes('/operations/')).length, 2)
  assert.equal(calls.filter(call => call.method === 'POST').length, 1)
})

test('a Peer target with an empty metadata revision re-reads its own operation contract', async () => {
  const { calls, state, run } = fixture({ supported: true, peerSupported: true })
  const target = '/api/rabilink/peer/http/remote/manager' + path
  state.remoteRevision = ''
  assert.equal((await run(click(), target)).ok, true)
  state.peerSupported = false
  assert.equal((await run(click(), target)).error.code, 'COMPUTER_IMAGE_VIEW_UNSUPPORTED')
  assert.equal(calls.filter(call => call.path.includes('/manager/api/agent/operations/')).length, 2)
  assert.equal(calls.filter(call => call.method === 'POST').length, 1)
})

test('a Peer instance ID keeps its encoded slash when identifying the computer route', async () => {
  const { calls, run } = fixture()
  const target = '/api/rabilink/peer/http/remote/manager/api/lan-agent/instances/folder%2Ffixture/computer'
  assert.equal((await run(click(), target)).error.code, 'COMPUTER_IMAGE_VIEW_UNSUPPORTED')
  assert.equal(calls.some(call => call.method === 'POST'), false)
})

test('computer Buffer JSON checks old receivers and preserves original new-receiver bytes', async () => {
  for (const target of [path, '/api/rabilink/peer/http/remote/manager' + path]) {
    const bytes = Buffer.from(JSON.stringify(click()))
    const old = fixture()
    assert.equal((await old.run(bytes, target)).error.code, 'COMPUTER_IMAGE_VIEW_UNSUPPORTED')
    assert.equal(old.calls.some(call => call.method === 'POST'), false)
    const current = fixture({ supported: true })
    const headers = { 'content-type': 'application/json', 'idempotency-key': 'original' }
    assert.equal((await current.run(bytes, target, headers)).ok, true)
    const write = current.calls.find(call => call.method === 'POST')
    assert.equal(write.body, bytes)
    assert.equal(write.headers['content-type'], 'application/json')
    assert.equal(write.headers['idempotency-key'], 'original')
  }
})

test('unrelated POST bodies bypass JSON parsing and Buffer decoding synchronously', () => {
  const original = JSON.parse
  JSON.parse = () => assert.fail('Unrelated API body was parsed')
  try {
    for (const body of [JSON.stringify(click()), Buffer.from('binary payload')]) {
      for (const pathname of ['/api/files/upload', '/api/rabilink/peer/http/remote/manager/api/files/upload']) {
        assert.equal(checkComputerImageView({ method: 'POST', pathname, init: { body } }), undefined)
      }
    }
  } finally {
    JSON.parse = original
  }
})
