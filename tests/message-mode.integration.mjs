// Legacy pre-rc.3 fixture. Current rc.3 check: DSH_SOURCE_ROOT=<checkout> node --test tests/message-mode.rc3.integration.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as mode from '../lib/message-mode.js'
import * as assistant from '../lib/assistant-mode.js'
import { internals, RABIROUTE_AGENT_TOOL_NAMES } from '../lib/index.js'

const root = process.env.DSH_SOURCE_ROOT
if (!root) throw new Error('DSH_SOURCE_ROOT must name a built official DSH checkout.')
const load = path => import(pathToFileURL(resolve(root, path)).href)
const { Context } = await load('vendor/cordis/lib/index.js')
const { default: SystemPrompt } = await load('packages/core/system-prompt/lib/index.js')
const { default: ToolRuntime } = await load('packages/core/tools/lib/index.js')
const { createScope, bindScopeParent, scopeTarget } = await load('packages/core/scope/lib/index.js')
const { apply: applySkillTool } = await load('packages/skill/tool-skill/lib/index.js')
const { default: WebRuntime } = await load('packages/web/web/lib/index.js')
const webTools = await load('packages/web/tool-web/lib/index.js')

for (const [label, presetMode, hasWeb] of [['message', mode, false], ['assistant', assistant, true]]) {
test(`real DSH ${label} runtime preserves its capabilities and hides unrelated tools and skills`, async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WebRuntime, {})
  const webCalls = []
  ctx.web.registerSearchProvider({ id: 'test-search', available: () => true, search: async request => {
    webCalls.push('search')
    return { sources: [{ url: 'https://example.org/', title: 'Example' }], truncated: false }
  } })
  ctx.web.registerFetchProvider({ id: 'test-fetch', available: () => true, fetch: async () => {
    webCalls.push('fetch')
    return { url: 'https://example.org/', statusCode: 200, body: { kind: 'text', content: 'Example source' }, truncated: false }
  } })
  const calls = []
  const meta = { health: { state: 'healthy', live: true, requiredReady: true }, applicationGenerationId: 'test', managerInstanceId: 'test' }
  for (const definition of internals.toolDefinitions({ managerBaseUrl: 'http://localhost:12345' }, {
    fetch: async (url, init) => {
      calls.push({ url, method: init.method })
      return new Response(JSON.stringify(url.endsWith('/meta') ? meta : { ok: true }))
    },
  })) ctx.tools.register(definition)
  let forbiddenExecutions = 0
  const foreign = name => ({ name, description: name, parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] },
    execute: async () => { forbiddenExecutions++; return 'executed' },
  })
  for (const name of ['cmd', 'read_file', 'write_file', 'search', 'workflow']) ctx.tools.register(foreign(name))
  const skillListeners = []
  let skillCatalogReads = 0
  applySkillTool({
    tools: ctx.tools,
    workingDirectory: { ensure: async () => 'C:/project' },
    skills: { snapshot: async () => {
      skillCatalogReads++
      return { complete: true, skills: [{ name: 'foreign-coding', description: 'Non-Rabi coding skill', provider: 'foreign', invocation: { modelInvocable: true, userInvocable: true } }] }
    } },
    on: (_name, listener) => skillListeners.push(listener),
  })
  let preset, sibling, child
  const presetKey = { id: 'message-preset' }, siblingKey = { id: 'standard' }, childKey = { id: 'message-session', session: { id: 'message-session', header: { cwd: 'C:/project' } } }
  await ctx.plugin(Object.assign(inner => {
    preset = createScope(inner, presetKey)
    sibling = createScope(inner, siblingKey)
    child = createScope(inner, childKey)
  }, { inject: ['tools', 'systemPrompt'] }))
  bindScopeParent(childKey, presetKey)
  // Match the installed assistant preset: official web tools are scope-local.
  if (hasWeb) {
    await preset.ctx.plugin(webTools, { search: true, fetch: true, searchMaxResults: 8, searchMaxQueries: 4,
      searchTimeoutMs: 60000, fetchTimeoutMs: 30000, fetchMaxOutputChars: 200000 })
  }
  const fiber = preset.ctx.plugin(presetMode)
  await fiber
  childKey.ctx = child.ctx
  await ctx.serial(scopeTarget(childKey, childKey), 'agent/created', { agent: childKey, source: 'startup' })
  const run = (name, args = {}, agent = childKey) => ctx.tools.execute({ name, arguments: args, agent,
    callId: 'test-call', signal: new AbortController().signal })
  try {
    assert.deepEqual(ctx.tools.schemas(childKey).map(t => t.name).sort(), [...RABIROUTE_AGENT_TOOL_NAMES, ...hasWeb ? ['web_search', 'web_fetch'] : []].sort())
    const assembly = await ctx.systemPrompt.assemble({ scope: childKey, agent: childKey })
    const guidance = assembly.sections.find(section => section.name === `rabiroute:${label}-mode`).text
    assert.match(guidance, /message-session/)
    if (hasWeb) {
      assert.match(guidance, /联网搜索/)
      assert.equal((await run('web_search', { queries: ['public information'] })).isError, false)
      assert.equal((await run('web_fetch', { url: 'https://example.org/' })).isError, false)
      assert.deepEqual(webCalls, ['search', 'fetch'])
    } else {
      assert.match(guidance, /优先分工，不是接口权限限制/)
      assert.match(guidance, /skills\/<skillId>/)
      assert.equal((await run('web_search', { queries: ['public information'] })).isError, true)
    }
    const catalog = agent => {
      agent.session ??= {}
      Object.assign(agent.session, { surface: { nodes: [] }, seq: 0 })
      return skillListeners[1]({ agent, signal: new AbortController().signal }, async () => ({ kind: 'continue', messages: [] }))
    }
    assert.deepEqual((await catalog(childKey)).messages, [])
    assert.equal(skillCatalogReads, 0)
    assert.equal((await catalog(siblingKey)).messages[0].source.entries[0].name, 'foreign-coding')
    assert.equal(skillCatalogReads, 1)
    for (const name of ['cmd', 'read_file', 'write_file', 'search', 'workflow', 'skill', 'run_code']) {
      assert.equal((await run(name)).isError, true, name)
    }
    ctx.tools.register(foreign('future_global'))
    assert.equal(ctx.tools.schemas(childKey).some(t => t.name === 'future_global'), false)
    // A late scoped tool is outside the inherited catalog mask; the final guard must still deny it.
    child.ctx.tools.register(foreign('late_scoped'))
    child.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })
    assert.equal((await run('late_scoped')).isError, true)
    assert.equal(forbiddenExecutions, 0)
    assert.equal((await run('read_file', {}, siblingKey)).isError, false)
    assert.equal(forbiddenExecutions, 1)
    for (const action of ['list', 'read', 'create', 'send']) {
      assert.equal((await run('rabiroute_agent_threads', { requestJson: JSON.stringify({ action }) })).isError, false)
    }
    assert.equal((await run('rabiroute_agent_send', { requestJson: '{"payload":{"type":"text","text":"test"}}' })).isError, false)
    assert.equal((await run('rabiroute_manager_api', { method: 'POST', path: '/api/roles/r/plans', bodyJson: '{"title":"test"}', requestHeadersJson: '{"Idempotency-Key":"test"}' })).isError, false)
    assert.ok(calls.some(call => call.url.endsWith('/api/roles/r/plans') && call.method === 'POST'))
    for (const path of ['/api/roles/r/skills', '/api/roles/r/skills/coordination', '/api/roles/r/persona-document', '/api/roles/r/memory/recent', '/api/roles/r/memory/consolidated/m', '/api/codex-hook/sessions/message-session']) {
      assert.equal((await run('rabiroute_manager_api', { method: 'GET', path })).isError, false, path)
      assert.ok(calls.some(call => call.url.endsWith(path)))
    }
    assert.equal((await run('rabiroute_manager_api', { method: 'POST', path: '/api/roles/r/memory/recent', bodyJson: '{"title":"confirmed","focus":"decision","content":"evidence","keywords":["topic"]}', requestHeadersJson: '{"Idempotency-Key":"memory-test"}' })).isError, false)
    assert.equal((await run('rabiroute_manager_api', { method: 'PATCH', path: '/api/roles/r/memory/recent/m', bodyJson: '{"content":"updated"}', requestHeadersJson: '{"Idempotency-Key":"memory-update","If-Match":"\\"v1\\""}' })).isError, false)
    for (const path of ['/api/roles/r/plans/p/attachments/a', '/api/agent/xiaomi-home/devices', '/api/config', '/api/future-service']) {
      assert.equal((await run('rabiroute_manager_api', { method: 'GET', path })).isError, false)
      assert.ok(calls.some(call => call.url.endsWith(path)))
    }
    await fiber.dispose()
    assert.equal((await run('late_scoped')).isError, false)
  } finally {
    await child.dispose()
    await sibling.dispose()
    await preset.dispose()
    await ctx.fiber.dispose()
  }
})
}
