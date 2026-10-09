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

test('discovery writes, unsupported methods and GET bodies fail before Host or network access', async () => {
  const api = tool({ hostStatus: async () => assert.fail('must not discover'), fetch: async () => assert.fail('must not fetch') })
  for (const path of paths) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      await assert.rejects(() => api.execute({ method, path: path + '?topic=send' }, exec()), /GET-only|Unsupported/)
    }
    await assert.rejects(() => api.execute({ method: 'GET', path, bodyJson: '{}' }, exec()), /cannot carry a body/)
  }
})

test('discovery extension does not admit adjacent APIs or unsafe encoded paths', async () => {
  const api = tool({ hostStatus: async () => assert.fail('must not discover'), fetch: async () => assert.fail('must not fetch') })
  const rejected = ['/api/agent/send', '/api/agent/threads', '/api/agent/helpful', '/api/agent/send/capabilitiesExtra', '/api/config']
  for (const path of paths) rejected.push(path + '/', path + '/child', path + '#fragment', path + '?q=raw space', path + '?q=\\', path + '/..', path + '/%2e%2e', path.replace('/agent/', '/agent%2f'), path.replace('/agent/', '/agent%5c'), path.replace('/agent/', '/agent%252f'), path + '%3f', path + '%23', path + '%00', path + '%', path + '%GG')
  for (const path of rejected) await assert.rejects(() => api.execute({ method: 'GET', path }, exec()), /allowlist|encoding|traversal|separator/)
  // Existing validation decodes ordinary path characters, but never separators twice.
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
