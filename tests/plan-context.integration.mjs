import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { installPlanContext } from '../lib/plan-context.js'

test('真实执行循环记录上下文；用户原文不变，新快照标明取代旧摘要，解绑清除', { skip: !process.env.DSH_SOURCE_ROOT }, async () => {
  const load = path => import(pathToFileURL(resolve(process.env.DSH_SOURCE_ROOT, path)).href)
  const { Context } = await load('vendor/cordis/lib/index.js')
  const require = createRequire(resolve(process.env.DSH_SOURCE_ROOT, 'packages/core/agent-loop/package.json'))
  const runtime = name => import(pathToFileURL(require.resolve('@deepseek-ai/dsh-' + name)).href)
  const llm = await runtime('llm')
  const ctx = new Context()
  for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent']) {
    await ctx.plugin((await runtime(name)).default)
  }
  await ctx.plugin((await load('packages/core/agent-loop/lib/index.js')).default, { agents: [] })
  const requests = []
  class Adapter extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      requests.push(structuredClone(request.messages))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new Adapter())
  const plan = { planId: 'p', roleId: 'r', title: '演示计划', status: '执行中', label: '执行中' }
  const state = { entries: { 'session-test': { plans: [plan] } }, updatedAt: 1000, stale: false, pending: false }
  const fork = ctx.plugin({ inject: ['systemPrompt'], apply(scope) { installPlanContext(scope, { get: () => state }) } })
  try {
    await fork
    const agent = await ctx.agentLoop.create('session-test', { provider: 'mock', model: 'mock' })
    const send = async text => {
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    await send('做一下吧')
    assert.equal(requests.length, 1)
    assert.match(JSON.stringify(requests[0]), /演示计划/)
    assert.match(JSON.stringify(requests[0]), /rabiroute_manager_api/)
    plan.status = plan.label = '等待 QA'
    await send('现在呢')
    assert.match(JSON.stringify(requests[1]), /等待 QA/)
    const latestContext = messages => messages.findLast(message => message.source?.plugin === '@deepseek-ai/dsh-system-prompt' && message.role === 'user')
    assert.doesNotMatch(JSON.stringify(latestContext(requests[1])), /执行中/)
    assert.match(latestContext(requests[1]).content[0].text, /supersedes earlier/)
    state.entries = {}
    await send('继续')
    assert.doesNotMatch(JSON.stringify(latestContext(requests[2])), /演示计划/)
    assert.match(latestContext(requests[2]).content[0].text, /no longer apply/)
    const user = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    assert.deepEqual(user.map(event => event.data.content[0].text), ['做一下吧', '现在呢', '继续'])
    assert.ok(agent.session.snapshotEvents().some(event => JSON.stringify(event).includes('rabiroute:bound-plans')))
  } finally { await fork.dispose(); await ctx.fiber.dispose() }
})
