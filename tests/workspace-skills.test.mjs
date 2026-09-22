import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createWorkspaceSkillProvider, workspaceIdentity } from '../src/workspace-skills.js'
import { apply } from '../lib/index.js'

test('Rabi enhancement registers the provider lazily and honors its disable switch', t => {
  const controller = new AbortController()
  t.after(() => controller.abort())
  const providers = []
  const ctx = { effect(fn) { const dispose = fn(); if (dispose) t.after(dispose) }, skills: { registerProvider: create => providers.push(create({ signal: controller.signal, invalidate() {} })) },
    inject(names, fn) { if (names.every(name => name in ctx)) fn(ctx) } }
  apply(ctx)
  assert.equal(providers[0].name, 'rabiroute-workspace')
  apply(ctx, { workspaceSkillsEnabled: false })
  assert.equal(providers.length, 1)
})

function fixture(t, ttl = 60000) {
  const controller = new AbortController()
  t.after(() => controller.abort())
  const state = { cwd: 'C:/Projects/Game', calls: [], invalidations: 0, fail: false, active: true }
  const request = async pathname => {
    state.calls.push(pathname)
    if (state.fail) return { ok: false, statusCode: 503, body: '{}' }
    const skill = { id: 'build-check', title: 'Build check', summary: 'Check builds', keywords: ['build'], status: state.active ? 'active' : 'archived', content: '# Build\nCheck the build.' }
    const body = pathname === '/api/gateways'
      ? [{ agentRoleId: 'Builder', agentAdapters: ['dsh'], agentStates: { dsh: { monitorThreadCwd: state.cwd } } }]
      : { data: pathname.endsWith('/skills') ? [skill] : skill }
    return { ok: true, statusCode: 200, body: JSON.stringify(body) }
  }
  const provider = createWorkspaceSkillProvider({ workspaceSkillCacheMs: ttl }, { signal: controller.signal, invalidate: () => state.invalidations++ }, { request })
  return { provider, state, controller, request }
}

test('normalizes Windows extended paths and UNC without resolving relative workspaces', () => {
  assert.equal(workspaceIdentity('\\\\?\\C:\\Projects\\Game\\'), 'c:/projects/game')
  assert.equal(workspaceIdentity('\\\\?\\UNC\\server\\share\\Game'), '//server/share/game')
  assert.equal(workspaceIdentity('c:/Projects/Other/../Game'), 'c:/projects/game')
  assert.equal(workspaceIdentity('.'), '')
  assert.notEqual(workspaceIdentity('/work/Game'), workspaceIdentity('/work/game'))
})

test('catalog, trigger metadata and body are limited to the session workspace', async t => {
  const { provider, state } = fixture(t)
  const [skill] = await provider.list({ cwd: '//?/C:/Projects/Game/' })
  assert.match(skill.name, /^rabi-builder-build-check-[a-f0-9]+$/)
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(skill.whenToUse, 'build')
  assert.equal((await provider.get(skill, { cwd: 'c:/projects/game' })).content, '# Build\nCheck the build.')
  assert.deepEqual(await provider.list({ cwd: 'C:/Projects/Game-old' }), [])
  assert.deepEqual(await provider.list({ cwd: 'C:/Projects/Game/child' }), [])
  assert.equal(await provider.get(skill, { cwd: 'C:/Projects/Other' }), undefined)
  assert.equal(state.calls.filter(path => path === '/api/gateways').length, 1)
  state.active = false
  assert.equal(await provider.get(skill, { cwd: state.cwd }), undefined)
})

test('expiry invalidates registry catalogs and removes moved workspace bindings', async t => {
  const { provider, state } = fixture(t, 15)
  const [skill] = await provider.list({ cwd: state.cwd })
  state.cwd = 'C:/Projects/Other'
  await delay(25)
  assert.equal(state.invalidations, 1)
  assert.deepEqual(await provider.list({ cwd: 'C:/Projects/Game' }), [])
  assert.equal(await provider.get(skill, { cwd: 'C:/Projects/Game' }), undefined)
  assert.equal((await provider.list({ cwd: state.cwd })).length, 1)
})

test('failed discovery is retried and never retained as an empty successful catalog', async t => {
  const { provider, state } = fixture(t)
  state.fail = true
  await assert.rejects(provider.list({ cwd: state.cwd }), /HTTP 503/)
  state.fail = false
  assert.equal((await provider.list({ cwd: state.cwd })).length, 1)
})

test('unmatched workspaces never query persona catalogs', async t => {
  const { provider, state } = fixture(t)
  assert.deepEqual(await provider.list({ cwd: 'C:/Projects/Unrelated' }), [])
  assert.deepEqual(state.calls, ['/api/gateways'])
})

test('parallel callers share discovery; cancellation and unload reject access', async t => {
  const { provider, state, controller } = fixture(t)
  const [a, b] = await Promise.all([provider.list({ cwd: state.cwd }), provider.list({ cwd: state.cwd })])
  assert.equal(a[0].name, b[0].name)
  assert.equal(state.calls.filter(path => path === '/api/gateways').length, 1)
  await assert.rejects(provider.list({ cwd: state.cwd, signal: AbortSignal.abort() }), { name: 'AbortError' })
  controller.abort()
  await assert.rejects(provider.list({ cwd: state.cwd }), { name: 'AbortError' })
})

test('same-workspace personas merge while repeated routes and disabled routes do not duplicate skills', async t => {
  const controller = new AbortController()
  t.after(() => controller.abort())
  const route = role => ({ agentRoleId: role, agentAdapters: ['dsh'], agentStates: { dsh: { monitorThreadCwd: '/work/game' } } })
  const provider = createWorkspaceSkillProvider({}, { signal: controller.signal, invalidate() {} }, { request: async pathname => ({ ok: true, body: JSON.stringify(pathname === '/api/gateways'
    ? [route('Builder'), route('Builder'), route('builder'), { ...route('Disabled'), enabled: false }]
    : { data: [{ id: 'build', title: 'Build', summary: 'Check', status: 'active' }] }) }) })
  const skills = await provider.list({ cwd: '/work/game' })
  assert.equal(skills.length, 2)
  assert.notEqual(skills[0].name, skills[1].name)
})
