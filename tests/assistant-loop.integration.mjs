import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fork } from 'node:child_process'
import { internals } from '../lib/index.js'

const root = process.env.DSH_SOURCE_ROOT
if (!root) throw new Error('DSH_SOURCE_ROOT is required')
const load = path => import(pathToFileURL(resolve(root, path)).href)
const { Context } = await load('vendor/cordis/lib/index.js')
const { default: Loader } = await load('vendor/loader/lib/index.js')
const { LlmAdapter, createUserMessage } = await load('packages/llm/llm/lib/index.js')
const { SessionId } = await load('packages/core/session/lib/index.js')
const modeUrl = new URL('../lib/assistant-mode.js', import.meta.url).href
const waitFor = async (predicate, label) => {
  const until = Date.now() + 15000
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const textChunks = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const toolChunks = (id, name, args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

test('delegation accepts before child finishes, accepts new input and resumes on result', async () => {
  const ctx = new Context()
  const temp = mkdtempSync(join(root, '.tmp-rabi-loop-'))
  const childGate = Promise.withResolvers()
  const secondGate = Promise.withResolvers()
  const admissionGate = Promise.withResolvers()
  const admissionReached = Promise.withResolvers()
  const requests = []
  let childEntered = false
  let childReleased = false
  let secondEntered = false
  let thirdEntered = false
  let thirdAborted = false
  let fourthEntered = false
  let fourthAborted = false
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      const messages = JSON.stringify(options.messages)
      requests.push(messages)
      if (messages.includes('WORKER4-GATED') && !messages.includes('ORIGINAL-TASK')) {
        if (messages.includes('RESUME-WORK4')) {
          yield* textChunks('WORKER4-RECOVERED')
        } else {
          fourthEntered = true
          await new Promise((resolve, reject) => {
            if (options.signal.aborted) { fourthAborted = true; reject(new Error('aborted')); return }
            options.signal.addEventListener('abort', () => { fourthAborted = true; reject(new Error('aborted')) }, { once: true })
          })
        }
      } else if (messages.includes('WORKER3-GATED') && !messages.includes('ORIGINAL-TASK')) {
        thirdEntered = true
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) { thirdAborted = true; reject(new Error('aborted')); return }
          options.signal.addEventListener('abort', () => { thirdAborted = true; reject(new Error('aborted')) }, { once: true })
        })
      } else if (messages.includes('WORKER2-GATED') && !messages.includes('ORIGINAL-TASK')) {
        secondEntered = true
        await secondGate.promise
        yield* textChunks('WORKER2-RESULT')
      } else if (messages.includes('WORKER-GATED') && !messages.includes('ORIGINAL-TASK')) {
        if (messages.includes('CORRECTION-SCOPE')) {
          yield* textChunks('WORKER-RESULT')
        } else {
          childEntered = true
          await childGate.promise
          childReleased = true
          yield* textChunks('WORKER-DRAFT')
        }
      } else if (messages.includes('AFTER-INTERRUPT')) {
        yield* textChunks('ANSWER-AFTER-INTERRUPT')
      } else if (messages.includes('WORKER-RESULT') && messages.includes('WORKER2-RESULT')) {
        yield* textChunks('PARENT-CONTINUED')
      } else if (messages.includes('WORKER-RESULT') || messages.includes('WORKER2-RESULT')) {
        yield* textChunks('PARENT-PARTIAL')
      } else if (messages.includes('PARENT-ANSWERED-NEW-INPUT')) {
        yield* textChunks('PARENT-SPOKE')
      } else if (messages.includes('NEW-INPUT')) {
        yield* toolChunks('say-call', 'rabiroute_assistant_say', { text: 'PARENT-ANSWERED-NEW-INPUT' })
      } else {
        yield* toolChunks('delegate-call', 'rabiroute_assistant_delegate', { description: 'fixture work', prompt: 'WORKER-GATED', name: 'worker' })
      }
    }
  }
  try {
    await ctx.plugin(Loader)
    for (const path of ['llm/llm', 'core/session', 'session/session-projection', 'core/system-prompt', 'core/tools', 'core/tool-executor-native', 'core/agent', 'fs/fs-local', 'session/working-directory', 'web/web']) {
      const plugin = await load(`packages/${path}/lib/index.js`)
      await ctx.plugin(plugin.default ?? plugin)
    }
    await ctx.plugin(await load('packages/session/session-persistence-jsonl/lib/index.js'), { root: temp })
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
    await ctx.plugin(await load('packages/subagent/tool-subagent-control/lib/index.js'))
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      if (exec.name === 'rabiroute_assistant_delegate') {
        admissionReached.resolve()
        await admissionGate.promise
      }
      return next()
    })
    ctx.llm.registerAdapter(['fixture'], new Adapter())
    for (const definition of internals.toolDefinitions({})) ctx.tools.register(definition)
    await ctx.agentPresets.register({ id: 'standard', plugins: [] })
    await ctx.agentPresets.register({ id: 'assistant-test', plugins: [
      { id: 'web', name: pathToFileURL(resolve(root, 'packages/web/tool-web/lib/index.js')).href, config: { search: true, fetch: true, searchTimeoutMs: 60000 } },
      { id: 'assistant-mode', name: modeUrl },
    ] })
    const handle = await ctx.agents.create({ sessionId: SessionId('rabi-loop-parent'),
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: scope => ctx.agentPresets.mount(scope, 'assistant-test').then(() => undefined),
    })
    const parent = handle.agent
    parent.followup(user('ORIGINAL-TASK'))
    await admissionReached.promise
    assert.equal(parent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'delegate-call'), false)
    const incoming = user('NEW-INPUT')
    parent.followup(incoming)
    admissionGate.resolve()
    await waitFor(() => childEntered, 'child model entered')
    await waitFor(() => parent.session.snapshotEvents().some(event => event.type === 'turn/end'), 'delegate turn ended')
    assert.equal(childReleased, false)
    const first = parent.session.snapshotEvents()
    assert.equal(first.filter(event => event.type === 'rabiroute/assistant-mode').length, 1)
    const receiptEvent = first.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'delegate-call')
    assert.equal(receiptEvent.data.message.isError, false)
    const receipt = JSON.parse(receiptEvent.data.message.content[0].text)
    assert.ok(receipt.childId && receipt.messageId)
    assert.equal(receipt.name, 'worker')
    const queued = first.find(event => event.type === 'agent/inbox/spliced' && JSON.stringify(event.data.inserted).includes('NEW-INPUT'))
    assert.ok(queued && queued.seq < receiptEvent.seq, 'new input was accepted during delegate admission')
    assert.equal(first.find(event => event.type === 'turn/end').data.reason.kind, 'completed')
    await waitFor(() => parent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'say-call'), 'parent answers while child blocked')
    const spokenEvent = parent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'say-call')
    const spoken = spokenEvent.data.message
    assert.equal(spoken.isError, false)
    assert.deepEqual(JSON.parse(spoken.content[0].text), { text: 'PARENT-ANSWERED-NEW-INPUT' })
    assert.equal(childReleased, false)
    const sent = await ctx.tools.execute({
      agent: parent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: 'correction-call', name: 'send_message', arguments: JSON.stringify({ agent: receipt.name, message: 'CORRECTION-SCOPE' }) }],
    })
    assert.equal(sent.results[0].result.isError, false)
    const child = ctx.agents.get(receipt.childId)
    assert.ok(child, 'correction targets the accepted child')
    assert.ok(JSON.stringify(child.session.snapshotEvents()).includes('CORRECTION-SCOPE'))
    const second = await ctx.tools.execute({
      agent: parent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: 'delegate-second', name: 'rabiroute_assistant_delegate', arguments: JSON.stringify({ description: 'second work', prompt: 'WORKER2-GATED', name: 'worker2' }) }],
    })
    assert.equal(second.results[0].result.isError, false)
    const secondReceipt = second.results[0].result.value
    assert.ok(secondReceipt.childId && secondReceipt.messageId)
    assert.notEqual(secondReceipt.childId, receipt.childId)
    await waitFor(() => secondEntered, 'second child entered')
    childGate.resolve()
    secondGate.resolve()
    await waitFor(() => JSON.stringify(parent.session.snapshotEvents()).includes('PARENT-CONTINUED'), 'parent continues after child result')
    const events = parent.session.snapshotEvents()
    assert.ok(JSON.stringify(events).includes('WORKER-RESULT'))
    assert.ok(JSON.stringify(events).includes('WORKER2-RESULT'))
    const notices = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled')
    assert.deepEqual(new Set(notices.map(event => event.data.source.senderSessionId)), new Set([receipt.childId, secondReceipt.childId]))
    assert.equal(new Set(notices.map(event => event.data.id)).size, 2)
    assert.ok(requests.some(request => request.includes('ORIGINAL-TASK') && request.includes('WORKER-RESULT')))
    assert.ok(requests.some(request => !request.includes('ORIGINAL-TASK') && request.includes('CORRECTION-SCOPE')))
    assert.equal(await ctx.sessions.flush(parent.session), true)
    const stored = await ctx.sessionPersistence.open(parent.session.id, 'read')
    try {
      const persisted = (await stored.read()).events
      assert.ok(persisted.some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'delegate-call' && JSON.stringify(event.data.message.content).includes(receipt.childId)))
      assert.ok(persisted.some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'say-call' && event.data.meta?.kind === 'rabi-assistant-say'))
      assert.ok(persisted.some(event => event.type === 'user/message' && event.data.id === incoming.id))
      assert.ok(JSON.stringify(persisted).includes('WORKER-RESULT'))
    } finally { await stored.close() }
    const normalized = {
      receipt: { childId: '<childId>', name: receipt.name, messageId: '<messageId>' },
      marker: first.find(event => event.type === 'rabiroute/assistant-mode').data,
      say: { output: JSON.parse(spoken.content[0].text), meta: spokenEvent.data.meta, isError: spoken.isError },
      originalTaskRetained: requests.some(request => request.includes('ORIGINAL-TASK') && request.includes('WORKER-RESULT')),
    }
    const pending = user('PENDING-BEFORE-RESTART')
    parent.send(pending, 'next-turn', false)
    await ctx.sessions.flush(parent.session)
    await handle.dispose()
    const resumedHandle = await ctx.agents.resume({ resumeSessionId: SessionId('rabi-loop-parent'),
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: scope => ctx.agentPresets.mount(scope, 'assistant-test').then(() => undefined),
    })
    const resumed = resumedHandle.agent
    const restored = resumed.session.snapshotEvents()
    assert.equal(restored.filter(event => event.type === 'rabiroute/assistant-mode').length, 1)
    assert.equal(restored.filter(event => event.type === 'subagent/catalog' && event.data.childId === receipt.childId).length, 1)
    assert.ok(restored.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === pending.id)))
    const continued = await ctx.tools.execute({
      agent: resumed, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: 'resume-child', name: 'send_message', arguments: JSON.stringify({ agent: receipt.name, message: 'AFTER-RESUME' }) }],
    })
    assert.equal(continued.results[0].result.isError, false)
    await waitFor(() => requests.some(request => request.includes('AFTER-RESUME') && !request.includes('ORIGINAL-TASK')), 'original child resumed with follow-up')
    await waitFor(() => ctx.agents.get(receipt.childId) === undefined, 'resumed child closes')
    const childStored = await ctx.sessionPersistence.open(receipt.childId, 'read')
    try {
      const childEvents = (await childStored.read()).events
      assert.ok(JSON.stringify(childEvents).includes('AFTER-RESUME'))
    } finally { await childStored.close() }
    const third = await ctx.tools.execute({
      agent: resumed, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: 'delegate-third', name: 'rabiroute_assistant_delegate', arguments: JSON.stringify({ description: 'interrupt work', prompt: 'WORKER3-GATED', name: 'worker3' }) }],
    })
    assert.equal(third.results[0].result.isError, false)
    const thirdReceipt = third.results[0].result.value
    await waitFor(() => thirdEntered, 'third child entered')
    const stopped = await ctx.tools.execute({
      agent: resumed, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: 'interrupt-third', name: 'interrupt_agent', arguments: JSON.stringify({ agent: thirdReceipt.name }) }],
    })
    assert.equal(stopped.results[0].result.isError, false)
    await waitFor(() => thirdAborted && ctx.agents.get(thirdReceipt.childId) === undefined, 'selected child stopped')
    resumed.followup(user('AFTER-INTERRUPT'))
    await waitFor(() => JSON.stringify(resumed.session.snapshotEvents()).includes('ANSWER-AFTER-INTERRUPT'), 'parent remains responsive after interrupt')
    const fourth = await ctx.tools.execute({
      agent: resumed, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: 'delegate-fourth', name: 'rabiroute_assistant_delegate', arguments: JSON.stringify({ description: 'restart work', prompt: 'WORKER4-GATED', name: 'worker4' }) }],
    })
    assert.equal(fourth.results[0].result.isError, false)
    const fourthReceipt = fourth.results[0].result.value
    await waitFor(() => fourthEntered, 'fourth child entered')
    await ctx.subagents.drainDescendants([resumed])
    await resumedHandle.dispose()
    assert.equal(fourthAborted, true)
    const restartedHandle = await ctx.agents.resume({ resumeSessionId: SessionId('rabi-loop-parent'),
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: scope => ctx.agentPresets.mount(scope, 'assistant-test').then(() => undefined),
    })
    const restarted = restartedHandle.agent
    assert.equal(restarted.session.snapshotEvents().filter(event => event.type === 'subagent/catalog' && event.data.childId === fourthReceipt.childId).length, 1)
    const recover = await ctx.tools.execute({
      agent: restarted, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: 'recover-fourth', name: 'send_message', arguments: JSON.stringify({ agent: fourthReceipt.name, message: 'RESUME-WORK4' }) }],
    })
    assert.equal(recover.results[0].result.isError, false)
    await waitFor(() => requests.some(request => request.includes('RESUME-WORK4') && !request.includes('ORIGINAL-TASK')), 'interrupted original child resumes')
    await waitFor(() => JSON.stringify(restarted.session.snapshotEvents()).includes('WORKER4-RECOVERED'), 'recovered child reports to parent')
    await restartedHandle.dispose()
    Object.assign(normalized, { correctionConsumed: true, distinctResultsConsumed: 2, originalChildResumed: true,
      pendingInputRecorded: true, targetedInterruptStopped: true, newInputAfterInterrupt: true,
      interruptedChildResumed: true })
    assert.deepEqual(normalized, JSON.parse(readFileSync(new URL('./expected/assistant-loop.json', import.meta.url), 'utf8')))
  } finally {
    admissionGate.resolve()
    childGate.resolve()
    secondGate.resolve()
    await ctx.fiber.dispose()
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('hard process exit preserves the accepted child and pending input for explicit recovery', async () => {
  const db = mkdtempSync(join(root, '.tmp-rabi-crash-'))
  const fixture = new URL('./fixtures/assistant-loop-process.mjs', import.meta.url)
  const resolver = new URL('./assistant-source-resolve.mjs', import.meta.url)
  const run = (phase, ids) => new Promise((resolveRun, rejectRun) => {
    const child = fork(fixture, [], {
      execArgv: ['--import', resolver.href],
      env: { ...process.env, RABI_TEST_DB: db, RABI_TEST_PHASE: phase, ...(ids ? { RABI_TEST_IDS: JSON.stringify(ids) } : {}) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let output = ''
    let message
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('message', value => { message = value })
    const timer = setTimeout(() => { child.kill(); rejectRun(new Error(`${phase} timed out: ${output}`)) }, 30000)
    child.on('error', error => { clearTimeout(timer); rejectRun(error) })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code !== (phase === 'crash' ? 91 : 0) || !message) {
        rejectRun(new Error(`${phase} exited code=${code} signal=${signal}: ${output}`))
      } else resolveRun(message)
    })
  })
  try {
    const original = await run('crash')
    assert.equal(original.kind, 'crash-ready')
    const recovered = await run('resume', original)
    assert.deepEqual(recovered, { kind: 'resume-complete', childId: original.childId, messageId: original.messageId })
  } finally {
    rmSync(db, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
