import assert from 'node:assert/strict'
import test from 'node:test'
import { internals } from '../lib/index.js'
import { messageModeGuard } from '../lib/message-mode.js'

const identity = { applicationGenerationId: 'test-generation', managerInstanceId: 'test-instance' }
const meta = { ...identity, health: { live: true, requiredReady: true, state: 'degraded' } }
const execute = () => ({ signal: new AbortController().signal })
const fixture = (reply = () => new Response('{"code":0}')) => {
  const calls = []
  const api = internals.toolDefinitions({}, {
    hostStatus: async () => ({ ...identity, managerBaseUrl: 'http://localhost:12345' }),
    fetch: async (url, init) => {
      calls.push({ url, ...init })
      return url.endsWith('/meta') ? new Response(JSON.stringify(meta)) : reply(url, init)
    },
  }).find(tool => tool.name === 'rabiroute_manager_api')
  return { api, calls }
}

test('all Rabi endpoints and HTTP methods reach Manager in the Rabi preset, including future APIs', async () => {
  const { api, calls } = fixture()
  for (const path of ['/api/agent/xiaomi-home/devices', '/api/agent/xiaomi-home/resources?includeActions=1', '/api/config', '/api/roles/r/plans/p/attachments/a', '/api/future-service/operation']) {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND']) {
      const args = { method, path }
      assert.equal(messageModeGuard({ name: api.name, arguments: args }), undefined)
      assert.equal((await api.execute(args, execute())).ok, true)
      const business = calls.findLast(call => !call.url.endsWith('/meta'))
      assert.equal(business.url, 'http://localhost:12345' + path)
      assert.equal(business.method, method)
    }
  }
})

test('business rejection is returned from Rabi, without local storage preconditions or replay', async () => {
  const body = { code: -1, error: { code: 'sample_permission_denied' } }
  const { api, calls } = fixture(() => new Response(JSON.stringify(body), { status: 403 }))
  const result = await api.execute({ method: 'PATCH', path: '/api/roles/r/plans/p', bodyJson: '{}' }, execute())
  assert.equal(result.statusCode, 403)
  assert.deepEqual(JSON.parse(result.body), body)
  assert.equal(calls.filter(call => !call.url.endsWith('/meta')).length, 1)
})

test('mutations forward business headers and current lifecycle identity, preserving original request', async () => {
  const { api, calls } = fixture()
  const args = { method: 'POST', path: '/api/agent/xiaomi-home/action-requests', bodyJson: '{"action":"sample"}',
    requestHeadersJson: JSON.stringify({ 'Idempotency-Key': 'sample-action-key', 'X-Rabi-Capability': 'sample-capability', 'x-rabiroute-expected-manager-instance-id': 'stale' }) }
  assert.equal((await api.execute(args, execute())).ok, true)
  const action = calls.find(call => call.url.endsWith('/action-requests'))
  assert.equal(action.headers['idempotency-key'], 'sample-action-key')
  assert.equal(action.headers['x-rabi-capability'], 'sample-capability')
  assert.equal(action.headers['x-rabiroute-expected-application-generation-id'], identity.applicationGenerationId)
  assert.equal(action.headers['x-rabiroute-expected-manager-instance-id'], identity.managerInstanceId)
  assert.equal(action.body, args.bodyJson)
  assert.equal(action.redirect, 'error')
})

test('generic API accepts JSON values, text and binary bodies with the requested content type', async () => {
  const { api, calls } = fixture()
  for (const args of [{ bodyJson: '[1,"sample"]' }, { bodyJson: 'false' }, { bodyText: 'sample text' }, { bodyText: '' }, { bodyBase64: 'AP8=' }]) {
    assert.equal((await api.execute({ method: 'POST', path: '/api/future-service/input', ...args, requestHeadersJson: '{"Content-Type":"application/sample"}' }, execute())).ok, true)
    const action = calls.findLast(call => call.url.endsWith('/input'))
    assert.equal(action.headers['content-type'], 'application/sample')
    if (args.bodyBase64) assert.deepEqual(action.body, Buffer.from([0, 255]))
    else assert.equal(action.body, args.bodyJson ?? args.bodyText)
  }
  for (const args of [{ bodyJson: '{}', bodyText: 'x' }, { bodyJson: '{' }, { bodyBase64: 'not base64' }]) await assert.rejects(() => api.execute({ method: 'POST', path: '/api/input', ...args }, execute()))
})

test('binary Rabi response preserves bytes, content type and response headers', async () => {
  const { api } = fixture(() => new Response(Buffer.from([0, 255, 128, 1]), { headers: { 'content-type': 'application/octet-stream', 'x-rabi-receipt': 'sample' } }))
  const result = await api.execute({ method: 'GET', path: '/api/resource/content' }, execute())
  assert.deepEqual(JSON.parse(result.body), { contentType: 'application/octet-stream', contentBase64: 'AP+AAQ==' })
  assert.equal(result.headers['x-rabi-receipt'], 'sample')
})
