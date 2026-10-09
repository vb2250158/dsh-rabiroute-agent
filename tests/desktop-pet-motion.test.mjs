import assert from 'node:assert/strict'
import test from 'node:test'
import { internals } from '../lib/index.js'
import { messageModeGuard } from '../lib/message-mode.js'

test('pet control admits only the exact POST command and GET receipt, excluding runtime acknowledgments', () => {
  const root = '/api/desktop-pet/roles/sample/motion'
  assert.equal(internals.validatePath(root, 'POST').decoded, root)
  assert.equal(internals.validatePath(root + '/sample-motion-1', 'GET').decoded, root + '/sample-motion-1')
  for (const [path, method] of [[root, 'GET'], [root + '/sample-motion-1', 'POST'], [root + '/runtime', 'POST'],
    [root + '/runtime', 'GET'], [root + '/sample-motion-1/child', 'GET'], [root + '/%2e%2e', 'GET'],
    ['/api/desktop-pet/roles/sample', 'PATCH'], ['/api/desktop-pet/roles/sample/packs', 'GET']]) {
    assert.throws(() => internals.validatePath(path, method), /allowlist|requires|GET-only|traversal/)
  }
})

test('motion tool forwards original idempotency key and body with current identity checks', async () => {
  const identity = { applicationGenerationId: 'test-generation', managerInstanceId: 'test-instance' }
  const calls = []
  const api = internals.toolDefinitions({}, {
    hostStatus: async () => ({ ...identity, managerBaseUrl: 'http://localhost:12345' }),
    fetch: async (url, init) => {
      calls.push([url, init])
      return new Response(JSON.stringify(url.endsWith('/meta') ? { ...identity, health: { live: true, requiredReady: true, state: 'healthy' } } : { code: 0, data: { status: 'accepted' } }))
    }
  }).find(tool => tool.name === 'rabiroute_manager_api')
  const body = { requestId: 'sample-motion-1', target: { kind: 'screen-corner', corner: 'top-left' }, mode: 'auto' }
  const result = await api.execute({ method: 'POST', path: '/api/desktop-pet/roles/sample/motion',
    bodyJson: JSON.stringify(body), requestHeadersJson: JSON.stringify({ 'Idempotency-Key': body.requestId }) }, { signal: new AbortController().signal })
  assert.equal(result.ok, true)
  const action = calls.find(([url]) => url.endsWith('/motion'))
  assert.deepEqual(JSON.parse(action[1].body), body)
  assert.equal(action[1].headers['Idempotency-Key'] ?? action[1].headers['idempotency-key'], body.requestId)
})
