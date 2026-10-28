import test from 'node:test'
import assert from 'node:assert/strict'
import { managerRequest, resolveManagerBase } from '../lib/connection.js'
const config = { managerBaseUrl: 'http://localhost:12345' }
const meta = (health = {}) => ({ applicationGenerationId: 'generation', managerInstanceId: 'instance', health: { state: 'degraded', live: true, requiredReady: true, businessReady: false, ...health } })
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })

test('verified endpoint hints avoid Host process queries and stale hints rediscover before a single write', async () => {
  for (const stale of [false, true]) {
    let hosts = 0, writes = 0
    const paths = []
    const result = await managerRequest({}, '/api/codex-hook/context', { method: 'POST' }, undefined, {
      endpointHint: async () => ({ ...meta(), managerBaseUrl: 'http://localhost:11111' }),
      hostStatus: async () => { hosts++; return { ...meta(), managerBaseUrl: config.managerBaseUrl } },
      onTiming: row => paths.push(row),
      fetch: async url => {
        if (url.endsWith('/meta')) return response(stale && url.includes('11111') ? { ...meta(), managerInstanceId: 'old' } : meta())
        writes++; return response({ code: 0 })
      },
    })
    assert.equal(result.ok, true); assert.equal(writes, 1); assert.equal(hosts, Number(stale))
    assert.equal(paths.filter(row => row.path[0] === 'manager-request').length, 1)
    assert.equal(paths.some(row => row.path[0] === 'manager-meta-after'), true)
    assert.ok(paths.every(row => row.startMs >= 0 && row.durationMs >= 0))
  }
})

test('Hook timing separates transport checks and bounded server steps without copying payloads', async () => {
  const timings = []
  const result = await managerRequest(config, '/api/codex-hook/context', { method: 'POST', body: 'private-prompt' }, undefined, {
    onTiming: row => timings.push(row),
    fetch: async url => {
      if (url.endsWith('/meta')) return response(meta())
      await new Promise(resolve => setTimeout(resolve, 8))
      return response({ code: 0, data: { additionalContext: 'private-context', timings: [
        { name: 'plan-followup', startMs: 0, durationMs: 2 }, { name: 'plan-completion', startMs: 2, durationMs: 2 },
        { name: 'secret/value', startMs: 0, durationMs: 2 }, { name: 'invalid', startMs: -1, durationMs: 1 },
        { name: 'future', startMs: 1e12, durationMs: 1 }, null,
      ] } })
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(timings.map(row => row.path), [['manager-meta-before'], ['manager-request'],
    ['manager-request', 'plan-followup'], ['manager-request', 'plan-completion'], ['manager-meta-after']])
  assert.doesNotMatch(JSON.stringify(timings), /private|secret/)
  const failed = []
  await managerRequest(config, '/api/codex-hook/context', { method: 'POST' }, undefined, {
    onTiming: row => failed.push(row), fetch: async url => url.endsWith('/meta') ? response(meta()) : Promise.reject(new Error('offline')),
  })
  assert.equal(failed.at(-1).failed, true)
  assert.deepEqual(failed.at(-1).path, ['manager-request'])
})

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
test('thread read-only POST timeout is a failed read, without a post-write identity check', async () => {
  for (const action of ['list', 'read']) {
    let metas = 0, business = 0
    const result = await managerRequest(config, '/api/agent/threads', { method: 'POST', body: JSON.stringify({ action }) }, undefined, { fetch: async url => {
      if (url.endsWith('/meta')) { metas++; return response(meta()) }
      business++; throw new Error('thread read timed out')
    } })
    assert.equal(business, 1); assert.equal(metas, 1)
    assert.equal(result.ok, false); assert.equal(result.uncertain, false)
    assert.equal(result.error.kind, 'request_failed')
  }
})
test('only exact thread list and read POSTs are classified read-only', async () => {
  for (const [pathname, body] of [
    ['/api/agent/threads', '{'],
    ['/api/agent/threads', JSON.stringify({ action: 'send' })],
    ['/api/agent/threads', JSON.stringify({ action: 'reconcile_delivery' })],
    ['/api/agent/threads/', JSON.stringify({ action: 'read' })],
    ['/api/agent/send', JSON.stringify({ action: 'read' })],
    ['/business', JSON.stringify({ action: 'read' })]
  ]) {
    let metas = 0, business = 0
    const result = await managerRequest(config, pathname, { method: 'POST', body }, undefined, { fetch: async url => {
      if (url.endsWith('/meta')) { metas++; return response(meta()) }
      business++; throw new Error('write timed out')
    } })
    assert.equal(business, 1); assert.equal(metas, 1)
    assert.equal(result.ok, false); assert.equal(result.uncertain, true)
    assert.equal(result.error.kind, 'write_outcome_uncertain')
  }
})
test('read-only thread POST does not mislabel server errors or generation change', async () => {
  for (const failure of ['http', 'generation']) {
    let metas = 0
    const result = await managerRequest(config, '/api/agent/threads', { method: 'POST', body: '{"action":"read"}' }, undefined, { fetch: async url => {
      if (url.endsWith('/meta')) { metas++; return response({ ...meta(), ...(metas > 1 ? { applicationGenerationId: 'next' } : {}) }) }
      return response({ code: -1 }, failure === 'http' ? 503 : 200)
    } })
    assert.equal(metas, 1); assert.equal(result.uncertain, false)
    assert.equal(result.error.kind, 'manager_rejected')
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


test('a stopped Host is reported explicitly without dispatching a business request', async () => {
  let sent = 0;
  const result = await managerRequest({}, '/api/codex-hook/context', { method: 'POST' }, undefined, {
    hostStatus: async () => ({ ok: true, state: 'stopped' }),
    fetch: async () => { sent++; throw new Error('unexpected request'); },
  });
  assert.equal(result.error.kind, 'host_stopped');
  assert.equal(result.uncertain, false);
  assert.equal(sent, 0);
});
