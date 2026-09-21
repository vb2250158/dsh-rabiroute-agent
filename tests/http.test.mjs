import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { managerRequest } from '../lib/connection.js'
import { internals } from '../lib/index.js'
const meta = { health: { state: 'healthy', live: true, requiredReady: true }, applicationGenerationId: 'fixture-generation', managerInstanceId: 'fixture-instance' }
async function fixture(t, handler, health = meta) {
  const server = createServer((req, res) => {
    if (req.url === '/meta') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(health)); return }
    handler(req, res)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed })
  return 'http://127.0.0.1:' + server.address().port
}
test('real HTTP write preserves body and concurrency headers', async t => {
  let count = 0, observed
  const base = await fixture(t, (req, res) => {
    count++; observed = req.headers
    res.setHeader('etag', '"next"'); res.setHeader('idempotency-key', req.headers['idempotency-key'])
    res.end('{"code":0,"id":"fixture"}')
  })
  const result = await managerRequest({ managerBaseUrl: base }, '/fixture', { method: 'PATCH', headers: { 'if-match': '"old"', 'idempotency-key': 'stable' }, body: '{}' })
  assert.equal(count, 1); assert.equal(result.ok, true); assert.equal(result.etag, '"next"'); assert.equal(observed['if-match'], '"old"')
})
test('real HTTP redirects are not followed or replayed', async t => {
  let targetCount = 0, sourceCount = 0
  const target = await fixture(t, (_req, res) => { targetCount++; res.end('{}') })
  const source = await fixture(t, (_req, res) => { sourceCount++; res.writeHead(307, { location: target + '/target' }); res.end() })
  const result = await managerRequest({ managerBaseUrl: source }, '/fixture', { method: 'POST', body: '{}' })
  assert.equal(result.ok, false); assert.equal(result.uncertain, true); assert.equal(sourceCount, 1); assert.equal(targetCount, 0)
})
test('degraded loopback Manager accepts tool plan write/readback and preserves recovery rejection', async t => {
  let writes = 0, stored, recovering = false
  const base = await fixture(t, async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'POST') {
      writes++
      if (recovering) {
        res.writeHead(503, { 'retry-after': '3' })
        res.end(JSON.stringify({ code: -1, error: 'PLAN_STORAGE_STARTUP_UNAVAILABLE' })); return
      }
      let body = ''
      for await (const chunk of req) body += chunk
      stored = { id: 'fixture-plan', ...JSON.parse(body) }
      res.setHeader('idempotency-key', req.headers['idempotency-key'])
    }
    res.setHeader('etag', '"fixture-v1"')
    res.end(JSON.stringify({ code: 0, data: stored }))
  }, { ...meta, health: { ...meta.health, state: 'degraded', businessReady: false } })
  const tool = internals.toolDefinitions({ managerBaseUrl: base }).find(tool => tool.name === 'rabiroute_manager_api')
  const execute = args => tool.execute(args, { signal: new AbortController().signal })
  const args = { method: 'POST', path: '/api/roles/example/plans', bodyJson: '{"title":"Fixture"}', requestHeadersJson: '{"Idempotency-Key":"fixture-key"}' }
  const saved = await execute(args)
  assert.equal(saved.ok, true); assert.equal(saved.uncertain, false); assert.equal(writes, 1)
  assert.equal(saved.etag, '"fixture-v1"'); assert.equal(saved.headers['idempotency-key'], 'fixture-key')
  const readback = await execute({ method: 'GET', path: '/api/roles/example/plans/fixture-plan' })
  assert.equal(readback.ok, true); assert.deepEqual(JSON.parse(readback.body).data, { id: 'fixture-plan', title: 'Fixture' })
  recovering = true
  const rejected = await execute(args)
  assert.equal(writes, 2); assert.equal(rejected.statusCode, 503); assert.equal(rejected.uncertain, true)
  assert.equal(rejected.headers['retry-after'], '3')
  assert.equal(JSON.parse(rejected.body).error, 'PLAN_STORAGE_STARTUP_UNAVAILABLE')
})
test('real HTTP operation timeout leaves writes uncertain and unreplayed', async t => {
  let count = 0
  const base = await fixture(t, () => { count++ })
  const started = Date.now()
  const result = await managerRequest({ managerBaseUrl: base, requestTimeoutMs: 1000 }, '/fixture', { method: 'POST', body: '{}' })
  assert.equal(count, 1); assert.equal(result.uncertain, true); assert.equal(result.statusCode, 0)
  assert.ok(Date.now() - started < 5000)
})
