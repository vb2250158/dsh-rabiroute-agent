import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspacePlans } from '../src/workspace-plans.js'
const cwd = 'C:/Project/Game'
const routes = [{ id: 'one', agentRoleId: 'role-a', agentAdapters: ['dsh'], agentStates: { dsh: { monitorThreadCwd: cwd } } }, { id: 'duplicate', agentRoleId: 'role-a', agentAdapters: ['codex'], agentStates: { codex: { monitorProjectPath: cwd } } }, { id: 'two', agentRoleId: 'role-b', agentAdapters: ['dsh'], agentStates: { dsh: { monitorThreadCwd: cwd } } }]
const sessions = [{ sessionId: 'a', cwd, projections: { values: { title: 'Session A' } } }, { sessionId: 'b', cwd: 'C:/Other' }, { sessionId: 'blank', cwd, blank: true }]
const palette = { accent: '#0891b2' }
const plan = (id, level) => ({ id, title: id, currentStep: 'Step', presentation: { statusLevel: level, palette, label: 'Working' }, taskBinding: { agentType: 'dsh', workspace: cwd, sessionId: 'a' }, secretaryBinding: { agentType: 'dsh', workspace: cwd, sessionId: 'a' } })
test('button discovery coalesces without listing sessions or querying plans', async () => {
 let calls = 0
 const read = createWorkspacePlans({}, () => { throw Error('No session list expected') }, { request: async path => { calls++; assert.equal(path, '/api/gateways'); return { ok: true, body: JSON.stringify(routes) } } })
 const values = await Promise.all(Array.from({ length: 30 }, () => read(new URLSearchParams({ cwd, action: 'match' }))))
 assert.equal(calls, 1); assert.ok(values.every(x => x.matched))
 assert.equal((await read(new URLSearchParams({ cwd: 'C:/Other', action: 'match' }))).matched, false)
})
test('role merge sends authoritative session scope before pagination and preserves colors', async () => {
 const calls = []
 const read = createWorkspacePlans({}, async () => sessions, { base: async () => 'http://localhost:1234', request: async (path, init) => {
  if (path === '/api/gateways') return { ok: true, body: JSON.stringify(routes) }
  const query = JSON.parse(init.body); calls.push({ path, query }); assert.deepEqual(query.bindingScope.sessionIds, ['a'])
  const role = path.includes('role-a') ? 'a' : 'b'
  const start = Number(query.cursor)
  return { ok: true, body: JSON.stringify({ data: { items: Array.from({ length: Math.max(0, 15 - start) }, (_, i) => plan(role + (i + start), role === 'a' ? 0 : 1)), total: 15, facets: { statuses: [{ status: 'Working', label: 'Working', count: 15, palette }], tags: [{ tag: 'tag', count: 15 }] } } }) }
 } })
 const params = new URLSearchParams({ cwd, query: 'keyword', status: 'Working', tag: 'tag' })
 const first = await read(params)
 assert.equal(first.total, 30); assert.equal(first.items.length, 20); assert.equal(first.facets.tags[0].count, 30)
 assert.equal(calls.length, 2); assert.equal(calls[0].query.query, 'keyword'); assert.deepEqual(calls[0].query.statuses, ['Working'])
 assert.deepEqual(first.items[0].sessions, [{ id: 'a', title: 'Session A' }]); assert.deepEqual(first.items[0].presentation.palette, palette)
 params.set('cursor', first.nextCursor); const second = await read(params)
 assert.equal(second.items.length, 10); assert.equal(second.nextCursor, '')
 assert.equal(new Set([...first.items, ...second.items].map(x => x.roleId + '/' + x.id)).size, 30)
})
test('failed discovery is retryable and cannot become a false empty result', async () => {
 let count = 0
 const read = createWorkspacePlans({}, async () => sessions, { request: async () => ++count === 1 ? { ok: false, statusCode: 503 } : { ok: true, body: JSON.stringify(routes) } })
 const params = new URLSearchParams({ cwd, action: 'match' })
 await assert.rejects(read(params), /503/)
 assert.equal((await read(params)).matched, true)
})
test('empty UI filter values do not filter out every plan', async () => {
 const read = createWorkspacePlans({}, async () => sessions, { base: async () => 'http://localhost:1234', request: async (path, init) => {
  if (path === '/api/gateways') return { ok: true, body: JSON.stringify(routes) }
  const query = JSON.parse(init.body)
  assert.deepEqual(query.statuses, []); assert.deepEqual(query.tags, [])
  return { ok: true, body: JSON.stringify({ data: { items: [plan(path, 1)], total: 1, facets: { statuses: [], tags: [] } } }) }
 } })
 assert.equal((await read(new URLSearchParams({ cwd, status: '', tag: '' }))).items.length, 2)
})
