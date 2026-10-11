import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installNativeHooks } from '../lib/native-hooks.js'
const profile = createRequire(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/web/package.json'))
const { Context } = profile('@deepseek-ai/cordis')
const { LlmAdapter, createUserMessage, ToolCallId } = profile('@deepseek-ai/dsh-llm')
const { SessionId } = profile('@deepseek-ai/dsh-session')
const { defineContentToolFixture } = profile('@deepseek-ai/dsh-tools')

class Adapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(options)
    const tool = this.requests.length === 1
    const block = tool ? { type: 'tool-call', id: ToolCallId('fixture-call'), name: 'echo', arguments: '{"text":"fixture"}' }
      : { type: 'text', text: 'finished' }
    yield { type: 'block-start', index: 0, blockType: block.type }
    if (tool) yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
    else yield { type: 'text-delta', index: 0, text: block.text }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } }
  }
}

test('built native hooks participate in the real DSH loop, preserve model context and record the final Stop', async () => {
  const root = new Context(), requests = [], adapter = new Adapter()
  root.provide('workingDirectory', { get: () => process.cwd(), ensure: async () => process.cwd() })
  try {
    for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent']) {
      await root.plugin(profile('@deepseek-ai/dsh-' + name).default, name === 'tools' ? { mode: 'native' } : {})
    }
    await root.plugin(profile('@deepseek-ai/dsh-agent-loop').default, { agents: [] })
    await root.plugin({ inject: ['sessionProjections', 'workingDirectory'], apply(ctx) {
      installNativeHooks(ctx, {}, { request: async (_config, _path, options) => {
        const body = JSON.parse(options.body); requests.push(body)
        const data = body.eventName === 'SessionStart' ? { additionalContext: 'fixture context' } : {}
        return { ok: true, statusCode: 200, body: JSON.stringify({ code: 0, data }) }
      } })
    } })
    root.llm.registerAdapter(['fixture'], adapter)
    root.tools.register(defineContentToolFixture({ name: 'echo', description: 'fixture echo',
      parameters: { text: { type: 'string', required: true } }, execute: async ({ text }) => [{ type: 'text', text }] }))
    const agent = await root.agentLoop.create(SessionId('native-hook-fixture'), { provider: 'fixture', model: 'fixture' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const toolResult = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    assert.equal(toolResult?.data.message.isError, false, JSON.stringify(toolResult))
    assert.deepEqual(requests.map(item => item.eventName), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'])
    assert.equal(requests.at(-1).lastAssistantMessage, 'finished')
    assert.ok(requests.every(item => item.agentType === 'dsh' && item.sessionId === agent.session.id && item.turnId === '1'))
    assert.match(JSON.stringify(adapter.requests[0].messages), /fixture context/)
    assert.ok(agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    assert.deepEqual(requests.slice(5).map(item => item.eventName), ['UserPromptSubmit', 'Stop'])
    const records = agent.session.snapshotEvents().filter(event => event.type.startsWith('plugin:dsh-rabiroute-agent/hook-'))
    assert.equal(records.length, 14)
    assert.ok(records.every(event => event.ignorable === true))
  } finally { await root.fiber.dispose() }
})
