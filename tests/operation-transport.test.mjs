import test from 'node:test'
import assert from 'node:assert/strict'
import { managerRequest } from '../src/connection.js'
import { createOperationTransport } from '../src/operation-transport.js'
const config = { managerBaseUrl: 'http://127.0.0.1:12345', localAgentUnrestricted: true }
const identity = { applicationGenerationId: 'synthetic-app', managerInstanceId: 'synthetic-manager' }
const meta = { ...identity, health: { live: true, requiredReady: true, state: 'healthy' } }

test('canonical finite receipts preserve JSON, text and binary while the legacy branch stays unchanged', async () => {
  const legacy = await managerRequest(config, '/text', {}, undefined, { fetch: async () => new Response('plain', { headers: { 'content-type': 'text/plain' } }) })
  assert.equal(legacy.body, '{"text":"plain"}')
  const payloads = [{ body: '{"code":0,"data":{"value":7}}', type: 'application/json', mode: 'text' },
    { body: 'plain', type: 'text/plain', mode: 'text' }, { body: new Uint8Array([0, 255, 3]), type: 'application/octet-stream', mode: 'bytes' }]
  for (const row of payloads) {
    const transport = createOperationTransport(config, { fetch: async () => new Response(row.body, { headers: { 'content-type': row.type } }) })
    const receipt = await transport.request('GET', '/result', { responseMode: row.mode })
    assert.equal(receipt.ok, true)
    if (row.mode === 'bytes') assert.deepEqual([...receipt.bodyBytes], [...row.body])
    else assert.equal(receipt.body, row.body)
  }
})

test('stream mode awaits consumers in order and releases the original reader', async () => {
  let reads = 0, cancelled = 0, active = 0
  const chunks = [], events = []
  const transport = createOperationTransport(config, { fetch: async () => new Response(new ReadableStream({
    pull(controller) { reads++; if (reads <= 2) controller.enqueue(new TextEncoder().encode('data: ' + reads + '\n\n')); else controller.close() },
    cancel() { cancelled++ },
  }), { headers: { 'content-type': 'text/event-stream' } }) })
  const result = await transport.request('GET', '/events', { responseMode: 'stream', onResponse: value => { events.push(value.statusCode) },
    async onChunk(value) { assert.equal(active++, 0); await new Promise(resolve => setTimeout(resolve, 5)); chunks.push(new TextDecoder().decode(value)); active-- } })
  assert.equal(result.ok, true)
  assert.deepEqual(events, [200])
  assert.equal(chunks.join(''), 'data: 1\n\ndata: 2\n\n')
  assert.equal(result.body, undefined)
  assert.equal(result.noReplay, true)
  assert.equal(active, 0)
  assert.equal(cancelled, 0, 'normal EOF closes the same stream without another request')
})

test('user cancellation interrupts a stalled stream consumer and never replays an uncertain write', async () => {
  const controller = new AbortController()
  let requests = 0, cancelled = 0, began
  const consumerBegan = new Promise(resolve => { began = resolve })
  const transport = createOperationTransport(config, { fetch: async () => {
    requests++
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array([1])); }, cancel() { cancelled++ } }),
      { headers: { 'content-type': 'text/event-stream' } })
  } })
  const pending = transport.request('POST', '/events', { responseMode: 'stream', signal: controller.signal,
    onChunk() { began(); return new Promise(() => {}) } })
  await consumerBegan
  controller.abort(new Error('synthetic user cancellation'))
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.uncertain, true)
  assert.equal(requests, 1)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(cancelled, 1)
})

test('invalid stream budgets fail before dispatch and finite mode does not buffer an event stream', async () => {
  let calls = 0
  const transport = createOperationTransport(config, { fetch: async () => { calls++; return new Response('event', { headers: { 'content-type': 'text/event-stream' } }) } })
  await assert.rejects(transport.request('POST', '/write', { maxResponseBytes: -1 }), /positive byte budget/)
  assert.equal(calls, 0)
  const result = await transport.request('GET', '/events')
  assert.equal(result.ok, false)
  assert.equal(result.transportError, 'RESPONSE_MODE_REQUIRED')
  assert.equal(calls, 1)
})

test('the shared WebSocket connector receives the verified origin, identity and original options', async () => {
  const channel = { close() {}, closed: Promise.resolve({ ok: true }) }
  let opened = 0, passed
  const transport = createOperationTransport(config, { fetch: async () => new Response(JSON.stringify(meta)),
    async openApiWebSocket(options) { opened++; passed = options; await options.verifyIdentity(); return channel } })
  const onMessage = async () => {}, signal = new AbortController().signal
  const result = await transport.openWebSocket('/socket', { headers: { 'x-original': 'kept' }, protocols: ['json'], onMessage, signal, drainOnRemoteClose: true },
    { transport: 'websocket', method: 'GET' }, identity)
  assert.equal(result, channel)
  assert.equal(opened, 1)
  assert.equal(passed.url.href, 'ws://127.0.0.1:12345/socket')
  assert.equal(passed.headers['x-original'], 'kept')
  assert.equal(passed.headers['x-rabiroute-expected-manager-instance-id'], identity.managerInstanceId)
  assert.equal(passed.onMessage, onMessage)
  assert.equal(passed.signal, signal)
  assert.equal(passed.drainOnRemoteClose, true)
  await assert.rejects(transport.openWebSocket('/socket', { onMessage }, {}, { ...identity, managerInstanceId: 'retired' }), /identity changed/)
  assert.equal(opened, 1)
})

test('invalid modes and missing stream consumers never send a business POST', async () => {
  let calls = 0
  const transport = createOperationTransport(config, { fetch: async () => { calls++; return new Response('{}') } })
  await assert.rejects(transport.request('POST', '/business', { responseMode: 'invalid' }), /response mode/)
  await assert.rejects(transport.request('POST', '/business', { responseMode: 'stream' }), /explicit consumer/)
  assert.equal(calls, 0)
})

test('a response-mode mismatch cannot hang on cancellation or claim a dispatched write was confirmed', async () => {
  let calls = 0, cancels = 0
  const transport = createOperationTransport(config, { fetch: async () => {
    calls++
    return new Response(new ReadableStream({ cancel() { cancels++; return new Promise(() => {}) } }),
      { headers: { 'content-type': 'text/event-stream' } })
  } })
  const result = await transport.request('POST', '/business')
  assert.equal(result.statusCode, 200)
  assert.equal(result.ok, false)
  assert.equal(result.transportError, 'RESPONSE_MODE_REQUIRED')
  assert.equal(result.uncertain, true)
  assert.equal(result.noReplay, true)
  assert.equal(calls, 1)
  assert.equal(cancels, 1)
})
