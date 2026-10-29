import test from 'node:test'
import assert from 'node:assert/strict'
import { managerRequest } from '../lib/connection.js'

test('unrestricted local Agent sends once without pre/post metadata requests', async () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const calls = []
    const result = await managerRequest({ managerBaseUrl: `http://${host}:12345`, localAgentUnrestricted: true }, '/api/codex-hook/context', { method: 'POST' }, undefined, {
      fetch: async url => { calls.push(url); return new Response('{"code":0}') }
    })
    assert.equal(result.ok, true)
    assert.equal(result.localUnrestricted, true)
    assert.deepEqual(calls, [`http://${host}:12345/api/codex-hook/context`])
  }
})

test('local mode keeps remote identity checks and does not replay uncertain writes', async () => {
  const calls = []
  const meta = { applicationGenerationId: 'app', managerInstanceId: 'manager', health: { live: true, requiredReady: true, state: 'healthy' } }
  const remote = await managerRequest({ managerBaseUrl: 'https://manager.example', localAgentUnrestricted: true }, '/business', { method: 'POST' }, undefined, {
    fetch: async url => { calls.push(url); return new Response(JSON.stringify(url.endsWith('/meta') ? meta : { code: 0 })) }
  })
  assert.equal(remote.ok, true)
  assert.notEqual(remote.localUnrestricted, true)
  assert.deepEqual(calls.map(x => new URL(x).pathname), ['/meta', '/business', '/meta'])
  let writes = 0
  const failed = await managerRequest({ managerBaseUrl: 'http://127.0.0.1:12345', localAgentUnrestricted: true }, '/business', { method: 'POST' }, undefined, {
    fetch: async () => { writes++; throw new Error('lost response') }
  })
  assert.equal(writes, 1)
  assert.equal(failed.uncertain, true)
})
