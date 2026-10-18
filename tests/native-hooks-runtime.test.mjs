import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
    const tool = this.toolsEnabled !== false && this.requests.length === 1
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

test('the real DSH loop completes an offline cached reply and restores its exact model-visible notice', async () => {
  const root = new Context(), adapter = new Adapter(), requests = []
  adapter.toolsEnabled = false
  const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-offline-hook-'))
  let connected = true, hooks
  root.provide('workingDirectory', { get: () => 'fixture-workspace', ensure: async () => 'fixture-workspace' })
  try {
    for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent']) await root.plugin(profile('@deepseek-ai/dsh-' + name).default, name === 'tools' ? { mode: 'native' } : {})
    await root.plugin(profile('@deepseek-ai/dsh-session-persistence-jsonl').default, { root: storageRoot, compression: 'none' })
    await root.plugin(profile('@deepseek-ai/dsh-agent-loop').default, { agents: [] })
    await root.plugin({ inject: ['sessionProjections', 'workingDirectory'], apply(ctx) {
      hooks = installNativeHooks(ctx, { hookContextCacheFile: join(storageRoot, 'private-cache.json'), hookContextForegroundMs: 1000 }, {
        clock: () => 10000,
        request: async (_config, _path, options) => {
          const body = JSON.parse(options.body); requests.push(body.eventName)
          if (!connected) return { ok: false, statusCode: 503, error: { message: 'offline fixture' } }
          return { ok: true, statusCode: 200, body: JSON.stringify({ code: 0, data: { binding: { roleId: 'fixture' }, additionalContext: body.eventName === 'SessionStart' ? 'confirmed fixture persona' : '' } }) }
        },
      })
    } })
    root.llm.registerAdapter(['fixture'], adapter)
    const agent = await root.agentLoop.create(SessionId('native-hook-offline-fixture'), { provider: 'fixture', model: 'fixture' })
    hooks.requireBinding(agent.session.id, 'fixture', { allowCachedContext: true })
    for (const content of ['hello', 'reply while disconnected']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } }))
      await agent.whenIdle()
      connected = false
    }
    const events = agent.session.snapshotEvents()
    const offlineNotice = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'dsh-rabiroute-agent').at(-1).data.content[0].text
    const expected = JSON.parse(await readFile(new URL('./expected/native-hooks-offline.json', import.meta.url), 'utf8'))
    assert.deepEqual({ modelCalls: adapter.requests.length, turns: events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind), requests, offlineNotice }, expected)
    assert.match(JSON.stringify(adapter.requests.at(-1).messages), /历史快照/)
    assert.equal(hooks.statusOf(agent.session.id).state, 'sync_unconfirmed')
    await root.sessions.flush(agent.session); await root.fiber.dispose()
    const reader = new Context()
    try {
      await reader.plugin(profile('@deepseek-ai/dsh-session-persistence-jsonl').default, { root: storageRoot, compression: 'none' })
      const handle = await reader.sessionPersistence.open(agent.session.id, 'read')
      try {
        const stored = (await handle.read()).events
        assert.equal(stored.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length, 2)
        assert.ok(stored.some(event => event.type === 'user/message' && event.data.content[0]?.text === expected.offlineNotice))
        assert.ok(stored.some(event => event.type.endsWith('hook-sync-unconfirmed') && event.data.dispatched === false))
      } finally { await handle.close() }
    } finally { await reader.fiber.dispose() }
  } finally {
    await root.fiber.dispose()
    assert.equal(dirname(storageRoot), tmpdir())
    await rm(storageRoot, { recursive: true, force: true })
  }
})

test('built native hooks participate in the real DSH loop, preserve model context and record the final Stop', async () => {
  const root = new Context(), requests = [], adapter = new Adapter()
  const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-native-hook-persistence-'))
  root.provide('workingDirectory', { get: () => process.cwd(), ensure: async () => process.cwd() })
  try {
    for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent']) {
      await root.plugin(profile('@deepseek-ai/dsh-' + name).default, name === 'tools' ? { mode: 'native' } : {})
    }
    await root.plugin(profile('@deepseek-ai/dsh-session-persistence-jsonl').default, { root: storageRoot, compression: 'none' })
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
    await root.sessions.flush(agent.session)
    assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason), [{ kind: 'completed' }])
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
    await root.sessions.flush(agent.session)
    await root.fiber.dispose()
    const reader = new Context()
    try {
      await reader.plugin(profile('@deepseek-ai/dsh-session-persistence-jsonl').default, { root: storageRoot, compression: 'none' })
      const handle = await reader.sessionPersistence.open(agent.session.id, 'read')
      try {
        const stored = (await handle.read()).events
        assert.equal(stored.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length, 2)
        assert.equal(stored.filter(event => event.type.startsWith('plugin:dsh-rabiroute-agent/hook-')).length, 14)
        assert.ok(stored.some(event => event.type === 'user/message' && event.data.source.kind === 'dsh-rabiroute-agent'))
      } finally { await handle.close() }
    } finally { await reader.fiber.dispose() }
  } finally {
    await root.fiber.dispose()
    assert.equal(dirname(storageRoot), tmpdir())
    await rm(storageRoot, { recursive: true, force: true })
  }
})
