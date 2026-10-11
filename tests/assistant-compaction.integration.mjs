// Keyless check against the production host: DSH_SOURCE_ROOT=<checkout> node --test tests/assistant-compaction.integration.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rabiAssistantPreset } from '../lib/assistant-preset.js'
import { internals } from '../lib/index.js'

if (!process.env.DSH_SOURCE_ROOT) throw new Error('DSH_SOURCE_ROOT must name a built DSH checkout.')
const load = path => import(pathToFileURL(resolve(process.env.DSH_SOURCE_ROOT, path)).href)
const { Context } = await load('vendor/cordis/lib/index.js')
const { default: Loader } = await load('vendor/loader/lib/index.js')
const { default: Group } = await load('vendor/group/lib/index.js')
const { LlmAdapter, createUserMessage } = await load('packages/llm/llm/lib/index.js')
const { SessionId } = await load('packages/core/session/lib/index.js')

test('assistant preset compacts before model requests, retains original history and isolates sibling sessions', async () => {
  const ctx = new Context()
  const requests = []
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 272000, maxTokens: 128000 } } }
    async *stream(options) {
      requests.push(options)
      const block = { type: 'text', text: 'Original task retained; ready to continue.' }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    const plugins = [
      ['llm/llm', ''], ['core/session', ''], ['session/session-projection', ''],
      ['core/system-prompt', ''], ['core/tools', ''], ['core/agent', ''],
      ['interaction/commands', ''], ['core/agent-loop', ''], ['llm/token-meter', ''],
      ['web/web', ''], ['preset/agent-preset-registry', ''],
    ]
    for (const [path] of plugins) {
      const plugin = (await load(`packages/${path}/lib/index.js`)).default
      await ctx.plugin(plugin, path === 'core/agent-loop' ? { agents: [] }
        : path === 'preset/agent-preset-registry' ? { default: 'rabi-assistant' } : {})
    }
    ctx.llm.registerAdapter(['fixture'], new Adapter())
    for (const definition of internals.toolDefinitions({})) ctx.tools.register(definition)
    const entries = structuredClone(rabiAssistantPreset.plugins)
    const native = {
      '@deepseek-ai/dsh-persona': 'preset/persona',
      '@deepseek-ai/dsh-tool-web': 'web/tool-web',
      '@deepseek-ai/dsh-compaction-basic': 'compaction/compaction-basic',
      '@deepseek-ai/dsh-command-compact': 'compaction/command-compact',
      '@deepseek-ai/dsh-compaction-tool-result-pruner': 'compaction/compaction-tool-result-pruner',
    }
    const locate = rows => {
      for (const row of rows) {
        if (native[row.name]) row.name = pathToFileURL(resolve(process.env.DSH_SOURCE_ROOT, 'packages', native[row.name], 'lib/index.js')).href
        else if (row.name === 'dsh-rabiroute-agent/assistant-mode') row.name = new URL('../lib/assistant-mode.js', import.meta.url).href
        if (row.group) locate(row.config)
      }
    }
    locate(entries)
    await ctx.plugin({ inject: ['agentPresets'], async apply(scope) {
      scope.effect(() => scope.agentPresets.register({ ...rabiAssistantPreset, plugins: entries }))
    } })
    const handle = await ctx.agents.create({ sessionId: SessionId('assistant-pressure-fixture'),
      agentOptions: { provider: 'fixture', model: 'fixture', maxTokens: 128000 },
      setup: (agentCtx) => ctx.agentPresets.mount(agentCtx, 'rabi-assistant').then(() => undefined),
    })
    const agent = handle.agent
    assert.ok(ctx.commands.list(agent).some(command => command.name === 'compact'))
    const sibling = await ctx.agents.create({ sessionId: SessionId('sibling-fixture') })
    assert.equal(ctx.commands.list(sibling.agent).some(command => command.name === 'compact'), false)
    // Seed existing logged history, then submit one new turn under the same preset.
    const history = Array.from({ length: 40 }, () => createUserMessage({ content: [{ type: 'text', text: 'original task evidence '.repeat(1000) }], source: { kind: 'user' } }))
    for (const message of history) agent.session.append('user/message', message, { surfaceOp: 'append' })
    const idle = new Promise((done, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('Assistant did not finish its turn')) }, 10000)
      const off = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { clearTimeout(timer); off(); done() }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue original task' }], source: { kind: 'user' } }))
    await idle
    const events = agent.session.snapshotEvents()
    assert.ok(events.some(event => event.type === 'compaction/end' && event.data.error === undefined), 'the assistant must compact automatically')
    assert.ok(history.every(message => events.some(event => event.type === 'user/message' && event.data.id === message.id)), 'raw history stays in the log')
    assert.ok(requests.length >= 2, 'summarization precedes the conversation request')
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('continue original task'))
    assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  } finally { await ctx.fiber.dispose() }
})
