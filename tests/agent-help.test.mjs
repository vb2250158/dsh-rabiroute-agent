import assert from 'node:assert/strict'
import test from 'node:test'
import { internals } from '../lib/index.js'

const paths = ['/api/agent/help', '/api/agent/send/capabilities']
const identity = { applicationGenerationId: 'test-generation', managerInstanceId: 'test-instance' }
const meta = { ...identity, health: { live: true, requiredReady: true, state: 'healthy' } }
const response = body => new Response(JSON.stringify(body))
const exec = () => ({ signal: new AbortController().signal })
const tool = dependencies => internals.toolDefinitions({}, dependencies).find(item => item.name === 'rabiroute_manager_api')

test('exact discovery GETs preserve ordinary queries and rediscover Host for each call', async () => {
  let discoveries = 0
  const calls = []
  const api = tool({
    hostStatus: async () => { discoveries++; return { ...identity, managerBaseUrl: 'http://localhost:12345' } },
    fetch: async (url, init) => { calls.push([url, init]); return response(url.endsWith('/meta') ? meta : { ok: true }) },
  })
  for (const path of paths) {
    for (const query of ['', '?topic=send&query=hello%20world&value=%2F%23%25']) {
      const result = await api.execute({ method: 'GET', path: path + query }, exec())
      assert.equal(result.ok, true)
      assert.deepEqual(result.identity, identity)
      assert.equal(calls.at(-2)[0], 'http://localhost:12345/meta')
      assert.equal(calls.at(-1)[0], 'http://localhost:12345' + path + query)
      assert.equal(calls.at(-1)[1].method, 'GET')
      assert.equal(calls.at(-1)[1].redirect, 'error')
    }
  }
  assert.equal(discoveries, 4)
})

test('invalid HTTP methods and GET bodies fail before Host or network access', async () => {
  const api = tool({ hostStatus: async () => assert.fail('must not discover'), fetch: async () => assert.fail('must not fetch') })
  for (const path of paths) {
    for (const method of ['', 'GET POST', 'GET\nPOST']) {
      await assert.rejects(() => api.execute({ method, path }, exec()), /Invalid HTTP/)
    }
    await assert.rejects(() => api.execute({ method: 'GET', path, bodyJson: '{}' }, exec()), /cannot carry a body/)
  }
})

test('unsafe encoded paths are rejected independently of the API endpoint', async () => {
  const api = tool({ hostStatus: async () => assert.fail('must not discover'), fetch: async () => assert.fail('must not fetch') })
  const rejected = []
  for (const path of paths) rejected.push(path + '#fragment', path + '?q=raw space', path + '?q=\\', path + '/..', path + '/%2e%2e', path.replace('/agent/', '/agent%5c'), path + '%00', path + '%', path + '%GG')
  for (const path of rejected) await assert.rejects(() => api.execute({ method: 'GET', path }, exec()), /relative path|encoding|traversal|separator/)
  // Ordinary encoded path characters and resource IDs remain callable.
  assert.equal(internals.validatePath('/api/agent/%68elp', 'GET').decoded, '/api/agent/help')
})

test('discovery still requires matching Host identity and Manager readiness', async () => {
  for (const path of paths) {
    for (const body of [{ ...meta, managerInstanceId: 'other' }, { ...meta, health: { live: true, requiredReady: false, state: 'starting' } }]) {
      let business = 0
      const api = tool({ hostStatus: async () => ({ ...identity, managerBaseUrl: 'http://localhost:12345' }), fetch: async url => { if (!url.endsWith('/meta')) business++; return response(body) } })
      assert.equal((await api.execute({ method: 'GET', path }, exec())).ok, false)
      assert.equal(business, 0)
    }
  }
})
