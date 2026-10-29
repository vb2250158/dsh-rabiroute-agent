import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { managerRequest, resolveManagerBase } from '../lib/connection.js'

const local = { managerBaseUrl: 'http://127.0.0.1:12345', localAgentUnrestricted: true }
const hook = '/api/codex-hook/context'

test('local discovery and writes perform no identity or permission preflight', async () => {
  assert.equal(await resolveManagerBase(local, undefined, { fetch: () => assert.fail('Local discovery must not request metadata') }), local.managerBaseUrl)
  const requests = []
  const result = await managerRequest({ localAgentUnrestricted: true }, hook, { method: 'POST' }, undefined, {
    endpointHint: async () => ({ managerBaseUrl: local.managerBaseUrl }),
    hostStatus: () => assert.fail('Published endpoint is enough'),
    fetch: async (url, options) => { requests.push({ url, options }); return new Response('{"code":0,"data":{}}') },
  })
  assert.equal(result.ok, true)
  assert.equal(requests.length, 1)
  assert.equal(Object.keys(requests[0].options.headers).some(x => x.startsWith('x-rabiroute-expected-')), false)
})

test('Hook progress is visible before headers and body complete without adding timing spans', async () => {
  const progress = [], timings = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const pending = managerRequest(local, hook, { method: 'POST', body: 'private-input' }, undefined, {
    onProgress: row => progress.push(row), onTiming: row => timings.push(row),
    fetch: async () => { await gate; return new Response('{"code":0,"data":{"additionalContext":"private-context"}}', { headers: { 'x-rabiroute-request-id': 'fixture-receipt' } }) },
  })
  assert.ok(progress.some(x => x.path.at(-1) === 'response-headers' && x.phase === 'started'))
  release()
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.diagnostic.reason, 'completed')
  assert.equal(result.diagnostic.requestId, 'fixture-receipt')
  assert.ok(progress.some(x => x.path.at(-1) === 'response-body' && x.phase === 'completed'))
  assert.deepEqual(timings.map(x => x.path), [['manager-request']])
  assert.doesNotMatch(JSON.stringify(progress), /private-input|private-context/)
})

test('a real stalled response body records timeout, original receipt and no write replay', async t => {
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests++
    response.writeHead(200, { 'content-type': 'application/json', 'x-rabiroute-request-id': 'body-wait-receipt' })
    response.write('{"private-response":')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const result = await managerRequest({ ...local, managerBaseUrl: 'http://127.0.0.1:' + server.address().port, requestTimeoutMs: 1000 }, hook, { method: 'POST' })
  assert.equal(result.ok, false)
  assert.equal(result.uncertain, true)
  assert.equal(requests, 1)
  assert.deepEqual(result.diagnostic, { timeoutMs: 1000, reason: 'timeout', stage: ['manager-request', 'response-body'], requestId: 'body-wait-receipt' })
  assert.doesNotMatch(JSON.stringify(result.diagnostic), /private-response/)
})

test('caller cancellation during endpoint discovery is distinct from a request timeout', async () => {
  const controller = new AbortController()
  const progress = []
  const pending = managerRequest({ localAgentUnrestricted: true }, hook, { method: 'POST' }, controller.signal, {
    onProgress: x => progress.push(x), fetch: () => assert.fail('Cancelled discovery must send nothing'),
    endpointHint: (_config, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  })
  controller.abort(new Error('Caller stopped waiting'))
  const result = await pending
  assert.equal(result.uncertain, false)
  assert.equal(result.diagnostic.reason, 'aborted')
  assert.deepEqual(result.diagnostic.stage, ['endpoint-hint'])
  assert.equal(progress.at(-1).phase, 'failed')
})

test('a caller cancellation remains cancellation when transport cleanup crosses the timeout budget', async () => {
  const controller = new AbortController()
  let abortObserved
  const observed = new Promise(resolve => { abortObserved = resolve })
  const pending = managerRequest({ ...local, requestTimeoutMs: 1000 }, hook, { method: 'POST' }, controller.signal, {
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      abortObserved()
      setTimeout(() => reject(signal.reason), 1100)
    }, { once: true })),
  })
  controller.abort(new Error('Caller cancelled'))
  await observed
  const result = await pending
  assert.equal(result.diagnostic.reason, 'aborted')
  assert.equal(result.uncertain, true)
})

test('verified remote metadata reads do not replace the Hook request receipt', async () => {
  let metas = 0
  const result = await managerRequest({ managerBaseUrl: 'https://manager.example.invalid' }, hook, { method: 'POST' }, undefined, {
    fetch: async url => url.endsWith('/meta')
      ? new Response(JSON.stringify({ applicationGenerationId: 'generation', managerInstanceId: 'manager', health: { live: true, requiredReady: true, state: 'healthy' } }), { headers: { 'x-rabiroute-request-id': 'metadata-' + ++metas } })
      : new Response('{"code":0,"data":{}}', { headers: { 'x-rabiroute-request-id': 'hook-receipt' } }),
  })
  assert.equal(metas, 2)
  assert.equal(result.ok, true)
  assert.equal(result.diagnostic.requestId, 'hook-receipt')
})
