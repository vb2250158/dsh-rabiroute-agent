import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { apply, internals, createRabiRouteAgentRuntimeStatus } from '../lib/index.js'
import { managerRequest, cleanBaseUrl } from '../lib/connection.js'
const origin = 'http://localhost:12345'
const meta = (id = 'one') => ({ health: { state: 'healthy', live: true, requiredReady: true }, applicationGenerationId: id, managerInstanceId: 'instance-' + id })
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })
const exec = () => ({ signal: new AbortController().signal })
const config = { managerBaseUrl: origin }
const tools = deps => internals.toolDefinitions(config, deps)
const general = deps => tools(deps).find(t => t.name === 'rabiroute_manager_api')

test('src and packaged lib match and have no fixed retired address', async () => {
  for (const name of ['index.js', 'connection.js', 'plan-panel.js', 'locate-agent.js', 'speech.js', 'speech-asr.js']) {
    const src = await readFile(new URL('../src/' + name, import.meta.url), 'utf8')
    assert.equal(src, await readFile(new URL('../lib/' + name, import.meta.url), 'utf8'))
    assert.doesNotMatch(src, /8790/)
  }
})
test('registers all tools and same-origin routes without contacting Host at registration', () => {
  const list = [], sections = [], routes = []
  const webServer = { register: route => { routes.push(route); return () => {} } }
  const ctx = { tools: { register: t => list.push(t) }, systemPrompt: { section: s => sections.push(s) }, webServer, effect: fn => fn(), inject: (names, fn) => { if (names.every(name => name in ctx)) return fn(ctx) }, on() {} }
  assert.equal(apply(ctx, { planContextEnabled: false }).active, true)
  assert.equal(list.length, 3)
  // Both routes exist for the same reason: the browser cannot reach Rabi itself. One
  // answers which plan a session is bound to, the other asks Rabi to raise another
  // client's window. They are registered the way any feature plugin claims a route.
  assert.deepEqual(routes.map(route => [route.kind, route.path]), [
    ['exact', '/rabiroute/plan-statuses'],
    ['exact', '/rabiroute/plan-events'],
    ['exact', '/rabiroute/plan-panel'],
    ['exact', '/rabiroute/locate-agent'],
    ['exact', '/rabiroute/speech'],
    ['exact', '/rabiroute/speech/asr'],
  ])
  assert.equal(createRabiRouteAgentRuntimeStatus().managerBaseUrl, '')
  assert.match(sections[0].text, /动态发现/)
  assert.doesNotMatch(sections[0].text, /8790/)
  assert.ok(list[2].parameters.properties.requestHeadersJson)
})
test('explicit origins reject credentials and paths', () => {
  for (const value of ['file:///tmp', 'http://a/path', 'http://u:p@a', 'http://a?q=1', 'http://a#x']) assert.throws(() => cleanBaseUrl(value))
})
test('discover a fresh Host URL each operation and verify identity', async () => {
  let generation = 'one'; const calls = []
  const deps = { hostStatus: async () => ({ ...meta(generation), managerBaseUrl: generation === 'one' ? origin : 'http://localhost:23456' }), fetch: async url => { calls.push(url); return response(meta(generation)) } }
  assert.equal((await managerRequest({}, '/meta', {}, exec().signal, deps)).ok, true)
  generation = 'two'
  assert.equal((await managerRequest({}, '/meta', {}, exec().signal, deps)).identity.applicationGenerationId, 'two')
  assert.match(calls.at(-1), /23456/)
})
test('Host identity mismatch and missing readiness prevent business dispatch', async () => {
  let business = 0
  const deps = { hostStatus: async () => ({ ...meta('wrong'), managerBaseUrl: origin }), fetch: async url => { if (!url.endsWith('/meta')) business++; return response(meta()) } }
  const result = await managerRequest({}, '/api/roles/example/plans', { method: 'POST' }, exec().signal, deps)
  assert.equal(result.ok, false); assert.equal(result.uncertain, false); assert.equal(business, 0)
  const missing = await managerRequest(config, '/anything', {}, exec().signal, { fetch: async () => response({ health: { state: 'healthy', live: true, requiredReady: true } }) })
  assert.equal(missing.ok, false)
})
test('header output and renderer retain strong ETag and echoed key', async () => {
  let seen
  const tool = general({ fetch: async (url, init) => { if (url.endsWith('/meta')) return response(meta()); seen = init; return response({ code: 0, data: { id: 'plan' } }, 200, { etag: '"v2"', 'idempotency-key': 'key' }) } })
  const args = { method: 'PATCH', path: '/api/roles/example/plans/plan', bodyJson: '{}', requestHeadersJson: JSON.stringify({ 'If-Match': '"v1"', 'Idempotency-Key': 'key' }) }
  const result = await tool.execute(args, exec())
  assert.equal(seen.headers['if-match'], '"v1"'); assert.equal(seen.redirect, 'error')
  assert.equal(result.etag, '"v2"'); assert.match(tool.output.render(args, result)[0].text, /idempotency-key/)
})
test('write errors and post-write generation changes never replay', async () => {
  for (const mode of ['network', '503', '412', 'generation']) {
    let business = 0, metas = 0
    const result = await managerRequest(config, '/api/roles/example/plans', { method: 'POST', body: '{}' }, exec().signal, { fetch: async url => {
      if (url.endsWith('/meta')) return response(meta(mode === 'generation' && ++metas > 1 ? 'two' : 'one'))
      business++
      if (mode === 'network') throw new Error('disconnected')
      return response({ code: mode === 'generation' ? 0 : -1 }, mode === '503' ? 503 : mode === '412' ? 412 : 200)
    } })
    assert.equal(business, 1); assert.equal(result.uncertain, mode !== '412')
  }
})
test('business GET is not replayed because reads may touch memory', async () => {
  let business = 0
  await managerRequest(config, '/api/roles/example/memory/recent/id', {}, exec().signal, { fetch: async url => { if (url.endsWith('/meta')) return response(meta()); business++; throw new Error('lost') } })
  assert.equal(business, 1)
})
test('discovery retry is bounded and does not use fallback ports', async () => {
  let count = 0
  const result = await managerRequest({}, '/meta', {}, exec().signal, { hostStatus: async () => { count++; throw new Error('Host unavailable') }, fetch: async () => assert.fail('must not fetch') })
  assert.equal(count, 2); assert.equal(result.error.kind, 'connection_not_ready')
})
test('reject path escapes, broad prefix confusion and non-GET health', async () => {
  const tool = general({ fetch: async () => assert.fail('must not fetch') })
  for (const p of ['/api/agent/requestsEvil', '//other/api/roles/x', '/api/roles/x/../../config', '/api/roles/x/%2e%2e/config', '/api/roles/x/%252e%252e/config', '/api/roles/x%2f..%2fconfig', '/api/roles/x\\..\\config', '/api/agent/send', '/api/config']) await assert.rejects(() => tool.execute({ method: 'GET', path: p }, exec()))
  await assert.rejects(() => tool.execute({ method: 'POST', path: '/meta' }, exec()), /GET-only/)
  assert.equal(internals.validatePath('/api/agent/send/receipts/example', 'GET').decoded, '/api/agent/send/receipts/example')
})
test('storage writes require only the applicable version headers', () => {
  assert.throws(() => internals.validateStorageHeaders('POST', '/api/roles/r/plans', {}), /Idempotency/)
  assert.throws(() => internals.validateStorageHeaders('PATCH', '/api/roles/r/plans/p', { 'idempotency-key': 'k' }), /If-Match/)
  assert.throws(() => internals.validateStorageHeaders('POST', '/api/roles/r/plan-statuses', { 'idempotency-key': 'k' }), /If-Match/)
  internals.validateStorageHeaders('POST', '/api/roles/r/plans', { 'idempotency-key': 'k' })
  for (const value of ['*', 'W/"v1"', '"a", "b"']) assert.throws(() => internals.requestHeaders(JSON.stringify({ 'If-Match': value })), /strong/)
  assert.throws(() => internals.requestHeaders('{"Authorization":"secret"}'), /Only/)
})
test('thread normalization preserves reply contract and rejects conflicting sources', () => {
  const request = { action: 'send', sourceThreadId: 'source', sourceAgentType: 'plan_secretary', responsePolicy: 'required', responseInstruction: 'reply', deliverySource: { agentAdapter: 'dsh', sessionId: 'source' } }
  const result = internals.normalizeThreadRequest(request)
  assert.equal(result.messageSource.sessionId, 'source'); assert.equal(result.responseInstruction, 'reply'); assert.equal('deliverySource' in result, false)
  assert.throws(() => internals.normalizeThreadRequest({ ...request, sourceThreadId: 'different' }), /match/)
})
test('already cancelled requests never dispatch business', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  let calls = 0
  const result = await managerRequest(config, '/api/roles/x/plans', { method: 'POST' }, controller.signal, { fetch: async (_url, init) => { calls++; init.signal.throwIfAborted(); return response(meta()) } })
  assert.equal(result.ok, false); assert.equal(result.uncertain, false); assert.equal(calls, 1)
})
