import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { internals } from '../../lib/index.js'

const root = process.env.DSH_SOURCE_ROOT
const db = process.env.RABI_TEST_DB
const phase = process.env.RABI_TEST_PHASE
if (!root || !db || !phase || !process.send) throw new Error('isolated process fixture configuration missing')
const load = path => import(pathToFileURL(resolve(root, path)).href)
const { Context } = await load('vendor/cordis/lib/index.js')
const { default: Loader } = await load('vendor/loader/lib/index.js')
const { LlmAdapter, createUserMessage } = await load('packages/llm/llm/lib/index.js')
const { SessionId } = await load('packages/core/session/lib/index.js')
const modeUrl = new URL('../../lib/assistant-mode.js', import.meta.url).href
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const chunks = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const waitFor = async (predicate, label) => {
  const until = Date.now() + 15000
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const ctx = new Context()
let childEntered = false
let pendingSeen = false
let resumedChildSeen = false
class Adapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    const messages = JSON.stringify(options.messages)
    if (messages.includes('CRASH-WORK') && !messages.includes('CRASH-PENDING') && !messages.includes('RESUME-PARENT')) {
      if (phase === 'resume' && messages.includes('CONTINUE-ORIGINAL')) {
        resumedChildSeen = true
        yield* chunks('CRASH-WORK-RESULT')
      } else {
        childEntered = true
        await new Promise(() => {})
      }
    } else {
      if (messages.includes('CRASH-PENDING')) pendingSeen = true
      yield* chunks('PARENT-RECOVERED')
    }
  }
}
try {
  await ctx.plugin(Loader)
  for (const path of ['llm/llm', 'core/session', 'session/session-projection', 'core/system-prompt', 'core/tools', 'core/tool-executor-native', 'core/agent', 'fs/fs-local', 'session/working-directory', 'web/web']) {
    const plugin = await load(`packages/${path}/lib/index.js`)
    await ctx.plugin(plugin.default ?? plugin)
  }
  await ctx.plugin(await load('packages/session/session-persistence-jsonl/lib/index.js'), { root: db })
  await ctx.plugin((await load('packages/core/agent-loop/lib/index.js')).default, { agents: [] })
  const Query = (await load('packages/session-query/session-query/lib/index.js')).default
  class TestQuery extends Query {
    searchSessions() { throw new Error('not used') }
    searchEvents() { throw new Error('not used') }
  }
  await ctx.plugin(TestQuery)
  await ctx.plugin((await load('packages/preset/agent-preset-registry/lib/index.js')).default, { default: 'standard' })
  await ctx.plugin((await load('packages/subagent/subagent/lib/index.js')).default)
  await ctx.plugin(await load('packages/subagent/subagent-spawn-in-process/lib/index.js'), { providerName: 'spawn' })
  ctx.llm.registerAdapter(['fixture'], new Adapter())
  for (const definition of internals.toolDefinitions({})) ctx.tools.register(definition)
  await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await ctx.agentPresets.register({ id: 'assistant-test', plugins: [
    { id: 'web', name: pathToFileURL(resolve(root, 'packages/web/tool-web/lib/index.js')).href, config: { search: true, fetch: true, searchTimeoutMs: 60000 } },
    { id: 'subagent-control', name: pathToFileURL(resolve(root, 'packages/subagent/tool-subagent-control/lib/index.js')).href },
    { id: 'assistant-mode', name: modeUrl },
  ] })
  const setup = scope => ctx.agentPresets.mount(scope, 'assistant-test').then(() => undefined)
  const options = { agentOptions: { provider: 'fixture', model: 'fixture' }, setup }
  if (phase === 'crash') {
    const handle = await ctx.agents.create({ sessionId: SessionId('hard-crash-parent'), ...options })
    const parent = handle.agent
    const delegated = await ctx.tools.execute({ agent: parent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: 'hard-delegate', name: 'rabiroute_assistant_delegate', arguments: JSON.stringify({ description: 'hard crash work', prompt: 'CRASH-WORK', name: 'hard-worker' }) }] })
    assert.equal(delegated.results[0].result.isError, false)
    const receipt = delegated.results[0].result.value
    await waitFor(() => childEntered, 'child blocked')
    const pending = user('CRASH-PENDING')
    parent.send(pending, 'next-turn', false)
    await ctx.sessions.flush(parent.session)
    await ctx.sessions.flush(ctx.agents.get(receipt.childId).session)
    const stored = await ctx.sessionPersistence.open(parent.id, 'read')
    try {
      const persisted = (await stored.read()).events
      assert.ok(persisted.some(event => event.type === 'subagent/catalog' && event.data.childId === receipt.childId))
      assert.ok(persisted.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === pending.id)))
      assert.equal(persisted.some(event => event.type === 'user/message' && event.data.id === pending.id), false)
    } finally { await stored.close() }
    process.send({ kind: 'crash-ready', childId: receipt.childId, messageId: pending.id }, error => {
      if (error) throw error
      process.exit(91)
    })
  } else {
    const original = JSON.parse(process.env.RABI_TEST_IDS)
    const handle = await ctx.agents.resume({ resumeSessionId: SessionId('hard-crash-parent'), ...options })
    const parent = handle.agent
    const events = parent.session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'subagent/catalog' && event.data.childId === original.childId).length, 1)
    assert.ok(events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === original.messageId)))
    // Wake the restored parent to consume the pre-crash pending input.
    parent.followup(user('RESUME-PARENT'))
    await waitFor(() => pendingSeen, 'pending input reaches resumed parent model')
    const sent = await ctx.tools.execute({ agent: parent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: 'hard-continue', name: 'send_message', arguments: JSON.stringify({ agent: original.childId, message: 'CONTINUE-ORIGINAL' }) }] })
    assert.equal(sent.results[0].result.isError, false)
    await waitFor(() => resumedChildSeen, 'same child resumes')
    await waitFor(() => parent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === original.messageId), 'pending ID consumed')
    await waitFor(() => JSON.stringify(parent.session.snapshotEvents()).includes('CRASH-WORK-RESULT'), 'child result returns')
    await ctx.sessions.flush(parent.session)
    const final = parent.session.snapshotEvents()
    assert.equal(final.filter(event => event.type === 'subagent/catalog').length, 1)
    assert.ok(final.some(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled' && event.data.source.senderSessionId === original.childId))
    await handle.dispose()
    await ctx.fiber.dispose()
    process.send({ kind: 'resume-complete', childId: original.childId, messageId: original.messageId }, error => {
      if (error) throw error
      process.exit(0)
    })
  }
} catch (error) {
  console.error(error?.stack ?? error)
  process.exit(1)
}
