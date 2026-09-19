// Run against a built official checkout: DSH_SOURCE_ROOT=<checkout> node --test tests/message-mode.integration.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as mode from '../lib/message-mode.js'
import { internals, RABIROUTE_AGENT_TOOL_NAMES } from '../lib/index.js'

const root = process.env.DSH_SOURCE_ROOT
if (!root) throw new Error('DSH_SOURCE_ROOT must name a built official DSH checkout.')
const load = path => import(pathToFileURL(resolve(root, path)).href)
const { Context } = await load('vendor/cordis/lib/index.js')
const { default: SystemPrompt } = await load('packages/core/system-prompt/lib/index.js')
const { default: ToolRuntime } = await load('packages/core/tools/lib/index.js')
const { createScope, bindScopeParent } = await load('packages/core/scope/lib/index.js')

test('real DSH runtime hides and denies file/code tools, preserves Rabi and sibling sessions', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const calls = []
  const meta = { health: { state: 'healthy', requiredReady: true }, applicationGenerationId: 'test', managerInstanceId: 'test' }
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
  for (const name of ['cmd', 'read_file', 'write_file', 'search', 'workflow', 'skill']) ctx.tools.register(foreign(name))
  let preset, sibling, child
  const presetKey = { id: 'message-preset' }, siblingKey = { id: 'standard' }, childKey = { id: 'message-session', session: { id: 'message-session', header: { cwd: 'C:/project' } } }
  await ctx.plugin(Object.assign(inner => {
    preset = createScope(inner, presetKey)
    sibling = createScope(inner, siblingKey)
    child = createScope(inner, childKey)
  }, { inject: ['tools', 'systemPrompt'] }))
  bindScopeParent(childKey, presetKey)
  const fiber = preset.ctx.plugin(mode)
  await fiber
  const run = (name, args = {}, agent = childKey) => ctx.tools.execute({ name, arguments: args, agent,
    callId: 'test-call', signal: new AbortController().signal })
  try {
    assert.deepEqual(ctx.tools.schemas(childKey).map(t => t.name).sort(), [...RABIROUTE_AGENT_TOOL_NAMES].sort())
    const assembly = await ctx.systemPrompt.assemble({ scope: childKey, agent: childKey })
    const guidance = assembly.sections.find(section => section.name === 'rabiroute:message-mode').text
    assert.match(guidance, /"sessionId":"message-session"/)
    assert.match(guidance, /所有具体业务工作都交给其他 Agent/)
    assert.match(guidance, /skills\/<skillId>/)
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
    const count = calls.length
    assert.equal((await run('rabiroute_manager_api', { method: 'GET', path: '/api/roles/r/plans/p/attachments/a' })).isError, true)
    assert.equal((await run('rabiroute_agent_send', { requestJson: '{"payload":{"type":"file","path":"secret"}}' })).isError, true)
    assert.equal(calls.length, count)
    await fiber.dispose()
    assert.equal((await run('late_scoped')).isError, false)
  } finally {
    await child.dispose()
    await sibling.dispose()
    await preset.dispose()
    await ctx.fiber.dispose()
  }
})
