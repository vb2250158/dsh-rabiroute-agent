import test from 'node:test'
import assert from 'node:assert/strict'
import { managerRequest, resolveManagerBase } from '../lib/connection.js'
const config = { managerBaseUrl: 'http://localhost:12345' }
const meta = (health = {}) => ({ applicationGenerationId: 'generation', managerInstanceId: 'instance', health: { state: 'degraded', live: true, requiredReady: true, businessReady: false, ...health } })
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })

test('degraded required-ready Manager accepts business reads, writes and UI discovery', async () => {
  for (const method of ['GET', 'POST']) {
    let business = 0
    const deps = { fetch: async url => url.endsWith('/meta') ? response(meta()) : (business++, response({ code: 0 })) }
    const result = await managerRequest(config, '/api/agent/threads', { method }, undefined, deps)
    assert.equal(result.ok, true); assert.equal(result.uncertain, false); assert.equal(business, 1)
    assert.equal(await resolveManagerBase(config, undefined, deps), config.managerBaseUrl)
  }
})
test('ordinary requests and UI discovery fail closed on invalid readiness', async () => {
  for (const health of [{ live: false }, { live: undefined }, { requiredReady: false }, { requiredReady: undefined }, { state: 'unknown' }, { state: undefined }]) {
    let business = 0
    const deps = { fetch: async url => url.endsWith('/meta') ? response(meta(health)) : (business++, response({})) }
    const result = await managerRequest(config, '/business', { method: 'POST' }, undefined, deps)
    assert.equal(result.ok, false); assert.equal(result.uncertain, false); assert.equal(business, 0)
    await assert.rejects(resolveManagerBase(config, undefined, deps), /not live and required-ready/)
  }
})
test('exact diagnostic GET reuses one identity-checked meta response regardless of readiness', async () => {
  let calls = 0
  const payload = meta({ live: false, requiredReady: false })
  const deps = { hostStatus: async () => ({ ...payload, managerBaseUrl: config.managerBaseUrl }), fetch: async () => { calls++; return response(payload) } }
  const result = await managerRequest({}, '/meta', {}, undefined, deps)
  assert.equal(calls, 1); assert.equal(result.ok, true); assert.equal(result.uncertain, false)
  assert.deepEqual(JSON.parse(result.body), payload)
  for (const pathname of ['/meta?x=1', '/meta/', '/META']) {
    const blocked = await managerRequest(config, pathname, {}, undefined, deps)
    assert.equal(blocked.ok, false)
  }
})
test('diagnostic still rejects missing identity and Host mismatch', async () => {
  for (const payload of [{ health: {} }, { ...meta(), managerInstanceId: ' ' }, meta()]) {
    const result = await managerRequest({}, '/meta', {}, undefined, { hostStatus: async () => ({ managerBaseUrl: config.managerBaseUrl, applicationGenerationId: 'other', managerInstanceId: 'instance' }), fetch: async () => response(payload) })
    assert.equal(result.ok, false); assert.equal(result.uncertain, false)
  }
})
test('post-write health degradation does not invalidate a same-identity receipt', async () => {
  for (const health of [{ state: 'degraded' }, { state: 'degraded', requiredReady: false, live: false }]) {
    let metas = 0, business = 0
    const result = await managerRequest(config, '/business', { method: 'POST' }, undefined, { fetch: async url => {
      if (url.endsWith('/meta')) return response(meta(++metas === 1 ? { state: 'healthy' } : health))
      business++; return response({ code: 0, id: 'plan' }, 200, { etag: '"next"', 'idempotency-key': 'stable' })
    } })
    assert.equal(business, 1); assert.equal(result.ok, true); assert.equal(result.uncertain, false)
    assert.equal(result.etag, '"next"'); assert.equal(result.headers['idempotency-key'], 'stable')
  }
})
test('post-write changed or unverifiable identities stay uncertain without replay', async () => {
  for (const mode of ['generation', 'instance', 'missing', 'network']) {
    let metas = 0, business = 0
    const result = await managerRequest(config, '/business', { method: 'POST' }, undefined, { fetch: async url => {
      if (!url.endsWith('/meta')) { business++; return response({ code: 0, id: 'plan' }) }
      if (++metas === 1) return response(meta())
      if (mode === 'network') throw new Error('unreachable')
      return response(mode === 'missing' ? {} : { ...meta(), ...(mode === 'generation' ? { applicationGenerationId: 'new' } : { managerInstanceId: 'new' }) })
    } })
    assert.equal(business, 1); assert.equal(result.ok, false); assert.equal(result.uncertain, true)
    assert.equal(JSON.parse(result.body).id, 'plan')
  }
})
