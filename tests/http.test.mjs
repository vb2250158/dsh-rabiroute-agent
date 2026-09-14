import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { managerRequest } from '../lib/connection.js'
const meta = { health: { state: 'healthy', requiredReady: true }, applicationGenerationId: 'fixture-generation', managerInstanceId: 'fixture-instance' }
async function fixture(t, handler) {
  const server = createServer((req, res) => {
    if (req.url === '/meta') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(meta)); return }
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
test('real HTTP operation timeout leaves writes uncertain and unreplayed', async t => {
  let count = 0
  const base = await fixture(t, () => { count++ })
  const started = Date.now()
  const result = await managerRequest({ managerBaseUrl: base, requestTimeoutMs: 1000 }, '/fixture', { method: 'POST', body: '{}' })
  assert.equal(count, 1); assert.equal(result.uncertain, true); assert.equal(result.statusCode, 0)
  assert.ok(Date.now() - started < 5000)
})
