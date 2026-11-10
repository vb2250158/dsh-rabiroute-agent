import test from 'node:test'
import assert from 'node:assert/strict'
import { createOperationToolRuntime, installOperationTools, CANONICAL_RABI_TOOL_NAMES } from '../src/operation-tools.js'
import { OPERATION_TOOL_DEFINITIONS } from '../lib/operation-sdk.js'

const identity = { applicationGenerationId: 'synthetic-app', managerInstanceId: 'synthetic-manager' }
const snapshot = { schemaVersion: '2', ...identity, pluginGenerationId: 'synthetic-plugins', catalogRevision: 1,
  catalogDigest: 'sha256:' + 'a'.repeat(64) }
const receipt = (data, statusCode = 200, extra = {}) => ({ statusCode, ok: statusCode >= 200 && statusCode < 300,
  body: JSON.stringify(data), headers: { 'content-type': 'application/json' }, identity, ...extra })
const operation = (id, transport = 'http') => ({ id, contractDigest: 'sha256:' + 'd'.repeat(64), contract: {
  operationId: id, contractVersion: '1.0.0', method: transport === 'http' ? 'POST' : 'GET', transport,
  pathTemplate: transport === 'http' ? '/api/example/:id' : '/api/' + transport,
  request: { path: { type: 'object' }, query: { type: 'object' }, body: { kind: 'json' } },
  responses: { 200: { mediaType: transport === 'http' ? 'application/json' : 'text/event-stream' } },
  effects: { mode: transport === 'http' ? 'business-write' : 'business-read' },
} })
const entries = new Map([['example.write', operation('example.write')], ['example.events', operation('example.events', 'sse')],
  ['example.socket', operation('example.socket', 'websocket')]])
function fixture(overrides = {}) {
  const calls = []
  const request = async (method, target, options = {}) => {
    calls.push({ method, target, options })
    if (target === '/api/agent/categories') return receipt({ code: 0, data: { ...snapshot, categories: [{ id: 'examples', title: 'Examples' }] } })
    if (target.startsWith('/api/agent/operations?')) return receipt({ code: 0, data: { ...snapshot, items: [{ operationId: 'example.write' }], nextCursor: 'next-page' } })
    if (target.startsWith('/api/agent/operations/')) {
      const name = decodeURIComponent(target.split('/').at(-1).split('?')[0]), selected = entries.get(name)
      return selected ? receipt({ code: 0, data: { ...snapshot, operation: selected } })
        : receipt({ code: -1, errorCode: 'UNKNOWN_OPERATION', field: 'operation', repair: 'Read the category catalog.' }, 404)
    }
    return overrides.request ? overrides.request(method, target, options) : receipt({ code: 0, data: { saved: true } })
  }
  const runtime = createOperationToolRuntime({ request, ...(overrides.openWebSocket ? { openWebSocket: overrides.openWebSocket } : {}) })
  const call = (name, args = {}, signal) => runtime.definitions.find(item => item.name === name).execute(args, { signal })
  return { runtime, call, calls }
}

test('the six DSH tools retain the shared canonical names, descriptions and input schema objects', async () => {
  const f = fixture()
  assert.deepEqual(CANONICAL_RABI_TOOL_NAMES, OPERATION_TOOL_DEFINITIONS.map(item => item.name))
  assert.equal(f.runtime.definitions.length, 6)
  for (const [i, definition] of f.runtime.definitions.entries()) {
    assert.equal(definition.parameters, OPERATION_TOOL_DEFINITIONS[i].inputSchema)
    assert.equal(definition.description, OPERATION_TOOL_DEFINITIONS[i].description)
    assert.equal(definition.timeoutMs, 61000)
  }
  await f.runtime.close()
})

test('categories, paginated search and per-operation input use the shared discovery SDK', async () => {
  const f = fixture()
  assert.equal((await f.call('rabi_categories')).data.categories[0].id, 'examples')
  assert.equal((await f.call('rabi_search', { query: '群聊 历史', category: 'messages', limit: 10, cursor: 'opaque/+?' })).data.nextCursor, 'next-page')
  const query = new URL(f.calls[1].target, 'http://synthetic').searchParams
  assert.equal(query.get('query'), '群聊 历史')
  assert.equal(query.get('cursor'), 'opaque/+?')
  assert.equal(query.get('limit'), '10')
  assert.equal((await f.call('rabi_describe', { operation: 'example.write' })).data.operation.id, 'example.write')
  assert.match(f.calls.at(-1).target, /view=input$/)
  assert.equal(f.calls.some(item => item.target === '/api/agent/help'), false)
  await f.runtime.close()
})

test('finite calls preserve the canonical input object, revision, contract digest and original request identity', async () => {
  const f = fixture()
  const result = await f.call('rabi_call', { operation: 'example.write', input: { pathParams: { id: 'one two' },
    query: { tag: ['a', 'b'] }, body: { value: 7 }, headers: { 'x-custom': 'kept' } }, requestId: 'request-original', expectedRevision: '"revision-original"' })
  assert.equal(result.ok, true)
  assert.equal(result.requestId, 'request-original')
  const request = f.calls.at(-1)
  assert.equal(request.target, '/api/example/one%20two?tag=a&tag=b')
  assert.deepEqual(JSON.parse(request.options.body), { value: 7 })
  assert.equal(request.options.headers['if-match'], '"revision-original"')
  assert.equal(request.options.headers['idempotency-key'], 'request-original')
  assert.equal(request.options.headers['x-custom'], 'kept')
  assert.equal(request.options.headers['x-rabiroute-api-contract'], entries.get('example.write').contractDigest)
  assert.equal(f.calls.filter(item => item.target.startsWith('/api/example/')).length, 1)
  assert.doesNotThrow(() => JSON.stringify(result))
  await f.runtime.close()
})

test('typed discovery errors retain code, repair, original receipt and no business dispatch', async () => {
  const f = fixture()
  const result = await f.call('rabi_describe', { operation: 'missing' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'UNKNOWN_OPERATION')
  assert.equal(result.details.field, 'operation')
  assert.equal(result.details.repair, 'Read the category catalog.')
  assert.equal(result.receipt.statusCode, 404)
  assert.equal(result.uncertain, false)
  assert.equal(f.calls.length, 1)
  const invalid = await f.call('rabi_categories', { extra: 'unaccepted' })
  assert.equal(invalid.error.code, 'TOOL_ARGUMENTS_INVALID')
  assert.equal(f.calls.length, 1)
  await f.runtime.close()
})

test('an uncertain write receipt remains uncertain and is never replayed', async () => {
  const f = fixture({ request: async () => receipt({}, 0, { ok: false, uncertain: true, errorCode: 'TRANSPORT_INTERRUPTED' }) })
  const result = await f.call('rabi_call', { operation: 'example.write', input: { pathParams: { id: 'one' } }, idempotencyKey: 'original-write' })
  assert.equal(result.ok, false)
  assert.equal(result.uncertain, true)
  assert.equal(result.requestId, 'original-write')
  assert.equal(result.statusCode, 0)
  assert.equal(f.calls.filter(item => item.target.startsWith('/api/example/')).length, 1)
  await f.runtime.close()
})

test('HTTP stream sessions read queued bytes and close the original request without replay', async () => {
  let started, aborted = 0
  const firstChunk = new Promise(resolve => { started = resolve })
  const f = fixture({ request: async (_method, target, options) => {
    assert.equal(target, '/api/sse')
    assert.equal(options.responseMode, 'stream')
    await options.onChunk(Buffer.from('data: first\n\n'))
    started()
    return new Promise(resolve => options.signal.addEventListener('abort', () => { aborted++; resolve(receipt({}, 200)) }, { once: true }))
  } })
  const opened = await f.call('rabi_call', { operation: 'example.events', requestId: 'original-stream' })
  assert.equal(opened.businessCompletion, false)
  assert.equal(opened.transport, 'sse')
  await firstChunk
  const read = await f.call('rabi_session', { sessionId: opened.sessionId, action: 'read' })
  assert.equal(Buffer.from(read.frames[0].data, 'base64').toString(), 'data: first\n\n')
  assert.equal(read.requestId, 'original-stream')
  const closed = await f.call('rabi_session', { sessionId: opened.sessionId, action: 'close' })
  assert.equal(closed.state, 'closed')
  assert.equal(aborted, 1)
  assert.equal(f.calls.filter(item => item.target === '/api/sse').length, 1)
  assert.equal((await f.call('rabi_session', { sessionId: opened.sessionId, action: 'close' })).state, 'not_present')
  await f.runtime.close()
})

test('WebSocket session frames use the shared owner and plugin disposal joins its close', async () => {
  let closeCount = 0, resolveClosed
  const sent = []
  const f = fixture({ openWebSocket: async (target, options) => {
    assert.equal(target, '/api/websocket')
    const closed = new Promise(resolve => { resolveClosed = resolve })
    return { closed,
      async sendAsync(value) { sent.push(value); await options.onMessage(value, { binary: false }) },
      async sendJsonAsync(value) { sent.push(value); await options.onMessage(value, { binary: false }) },
      close() { closeCount++; resolveClosed(receipt({ code: 0 })) } }
  } })
  const opened = await f.call('rabi_call', { operation: 'example.socket', requestId: 'socket-original' })
  assert.equal(opened.state, 'open')
  const ack = await f.call('rabi_session', { sessionId: opened.sessionId, action: 'send', text: 'hello' })
  assert.equal(ack.businessCompletion, false)
  assert.deepEqual(sent, ['hello'])
  const read = await f.call('rabi_session', { sessionId: opened.sessionId, action: 'read' })
  assert.deepEqual(read.frames, [{ encoding: 'text', data: 'hello' }])
  const closing = f.runtime.close()
  assert.equal(closing, f.runtime.close())
  await closing
  assert.equal(closeCount, 1)
  const after = await f.call('rabi_categories')
  assert.equal(after.error.code, 'RABI_OPERATION_SCOPE_CLOSED')
})

test('scope disposal cancels finite work and discards a late success', async () => {
  let complete, invoked
  const started = new Promise(resolve => { invoked = resolve })
  const request = async () => { invoked(); return new Promise(resolve => { complete = resolve }) }
  const runtime = createOperationToolRuntime({ request })
  const work = runtime.definitions[0].execute({}, {})
  await started
  await runtime.close()
  complete(receipt({ code: 0, data: { ...snapshot, categories: ['must-not-escape'] } }))
  const result = await work
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'RABI_OPERATION_SCOPE_CLOSED')
  assert.equal(result.aborted, true)
  assert.equal(result.data, undefined)
})

test('DSH effects own registration and cleanup of the six shared definitions', async () => {
  const effects = [], registered = new Map(), f = fixture()
  await f.runtime.close()
  const ctx = { effect(fn) { const dispose = fn(); if (dispose) effects.push(dispose) },
    tools: { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) } } }
  const runtime = installOperationTools(ctx, { request: async () => receipt({ code: 0, data: { ...snapshot, categories: [] } }) })
  assert.equal(registered.size, 6)
  for (const dispose of effects.reverse()) await dispose()
  assert.equal(registered.size, 0)
  assert.equal((await runtime.definitions[0].execute({}, {})).error.code, 'RABI_OPERATION_SCOPE_CLOSED')
})

test('the same discovery and input contract reaches an independent loopback Manager once', async t => {
  const { createServer, request } = await import('node:http')
  const received = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    received.push({ method: req.method, target: req.url, headers: req.headers, body })
    let data
    if (req.url === '/api/agent/categories') data = { code: 0, data: { ...snapshot, categories: [{ id: 'examples' }] } }
    else if (req.url.startsWith('/api/agent/operations?')) data = { code: 0, data: { ...snapshot, items: [{ operationId: 'example.write' }], nextCursor: '' } }
    else if (req.url.startsWith('/api/agent/operations/')) data = { code: 0, data: { ...snapshot, operation: entries.get('example.write') } }
    else data = { code: 0, data: { saved: JSON.parse(body) } }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const address = server.address()
  const transport = (method, target, options = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path: target, method, agent: false,
      headers: options.headers, signal: options.signal }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ ok: res.statusCode === 200, statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString(), headers: res.headers, identity }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
  const runtime = createOperationToolRuntime({ request: transport })
  t.after(() => runtime.close())
  const call = (name, args = {}) => runtime.definitions.find(item => item.name === name).execute(args)
  assert.equal((await call('rabi_categories')).data.categories[0].id, 'examples')
  await call('rabi_search', { query: '示例', limit: 10 })
  const description = await call('rabi_describe', { operation: 'example.write' })
  assert.deepEqual(description.data.operation.contract.request, entries.get('example.write').contract.request)
  const result = await call('rabi_call', { operation: 'example.write', input: { pathParams: { id: 'one two' }, body: { marker: 'same-input' } }, requestId: 'loopback-original' })
  assert.deepEqual(result.data.data.saved, { marker: 'same-input' })
  const writes = received.filter(item => item.method === 'POST')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].target, '/api/example/one%20two')
  assert.equal(writes[0].headers['idempotency-key'], 'loopback-original')
  assert.equal(writes[0].headers['x-rabiroute-api-contract'], entries.get('example.write').contractDigest)
  assert.equal(received.some(item => item.target === '/api/agent/help'), false)
})

test('typed failures keep a distinct trace request ID and original idempotency key', async () => {
  const f = fixture()
  const result = await f.call('rabi_call', { operation: 'missing', requestId: 'trace-original', idempotencyKey: 'write-original' })
  assert.equal(result.error.code, 'UNKNOWN_OPERATION')
  assert.equal(result.requestId, 'trace-original')
  assert.equal(result.idempotencyKey, 'write-original')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'GET')
  await f.runtime.close()
})
