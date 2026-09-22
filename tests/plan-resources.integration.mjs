import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { installPlanResources } from '../lib/plan-resources-install.js'

test('真实工具注册、多计划执行门禁与已记录的模型上下文', { skip: !process.env.DSH_SOURCE_ROOT }, async () => {
  const load = path => import(pathToFileURL(resolve(process.env.DSH_SOURCE_ROOT, path)).href)
  const { Context } = await load('vendor/cordis/lib/index.js')
  const require = createRequire(resolve(process.env.DSH_SOURCE_ROOT, 'packages/core/agent-loop/package.json'))
  const runtime = name => import(pathToFileURL(require.resolve('@deepseek-ai/dsh-' + name)).href)
  const llm = await runtime('llm')
  const ctx = new Context()
  const directory = await mkdtemp(join(tmpdir(), 'rabi-resource-runtime-'))
  try {
    for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent']) await ctx.plugin((await runtime(name)).default)
    await ctx.plugin((await load('packages/core/agent-loop/lib/index.js')).default, { agents: [] })
    class Adapter extends llm.LlmAdapter {
      async resolveModel(provider, model) { return { provider, id: model, name: model } }
      async *stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new Adapter())
    const cache = { get: () => ({ entries: { 'session-test': { plans: [{ roleId: 'r', planId: 'p1' }, { roleId: 'r', planId: 'p2' }] } }, stale: false, pending: false }) }
    await ctx.plugin({ inject: ['systemPrompt', 'tools'], apply(scope) {
      installPlanResources({ tools: scope.tools, systemPrompt: scope.systemPrompt, attachments: {}, on: scope.on.bind(scope), effect: scope.effect.bind(scope) }, { planResourcesDirectory: directory }, cache)
      scope.tools.register({ name: 'test_action', description: 'Test action', parameters: { type: 'object', properties: {}, additionalProperties: false }, output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] }, async execute() { return 'unexpected' } })
    } })
    const agent = await ctx.agentLoop.create('session-test', { provider: 'mock', model: 'mock' })
    const exec = { agent, callId: 'test-call', name: 'rabiroute_plan_resources', arguments: { action: 'list' }, signal: new AbortController().signal }
    const listed = await ctx.tools.execute(exec)
    assert.equal(listed.isError, false)
    assert.deepEqual(JSON.parse(listed.value.resultJson).pending, [])
    const denied = await ctx.tools.execute({ ...exec, callId: 'denied-call', name: 'test_action', arguments: {} })
    assert.equal(denied.isError, true)
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: '处理这项变更' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    assert.ok(agent.session.snapshotEvents().some(event => JSON.stringify(event).includes('rabiroute:plan-resources')))
    assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user').map(event => event.data.content[0].text), ['处理这项变更'])
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})
