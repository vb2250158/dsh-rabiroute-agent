import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, assistantModePrompt, assistantToolDefinitions, acceptedBackgroundThread, ASSISTANT_MODE_EVENT, RABI_ASSISTANT_TOOL_NAMES } from '../lib/assistant-mode.js'
import { apply as hostApply, RABIROUTE_AGENT_TOOL_NAMES } from '../lib/index.js'
import { rabiAssistantPreset } from '../lib/assistant-preset.js'

test('installed plugin registers a portable Rabi assistant preset and owns its disposal', async () => {
  const rows = [], effects = []
  const ctx = {
    provide() {},
    effect: fn => effects.push(fn()),
    agentPresets: { register: async row => { rows.push(row); return () => rows.pop() } },
    inject: (names, fn) => { if (names.every(name => name in ctx)) fn(ctx) },
  }
  hostApply(ctx, {})
  assert.deepEqual(rows, [rabiAssistantPreset])
  assert.equal(rows[0].id, 'rabi-assistant')
  assert.equal(rows[0].name, 'Rabi助手模式')
  assert.match(rows[0].description, /全部 Rabi 接口/)
  assert.deepEqual(rows[0].plugins.map(row => row.name), ['@deepseek-ai/dsh-tool-executor-native', '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-subagent-control', 'cordis:group', 'dsh-rabiroute-agent/assistant-mode'])
  assert.deepEqual(rows[0].plugins[2].config, { search: true, fetch: true, searchTimeoutMs: 60000 })
  for (const effect of effects) (await effect)?.()
  assert.equal(rows.length, 0)
})

test('assistant preserves web search and fetch while denying unrelated tools', () => {
  const seen = {}
  const tools = {
    restrict: value => { seen.allow = value.allow },
    guard: value => { seen.guard = value },
    register() {},
    get: name => ({ name, execute: async () => ({ ok: true }) }),
  }
  apply({ tools, on: (name, listener) => { if (name === 'agent/created') seen.created = listener },
    effect: fn => fn(),
    systemPrompt: { section: value => { seen.promptOrder = value.order; seen.prompt = value.text({ agent: { session: { id: 'session-test' } } }) } } })
  const events = []
  const session = { snapshotEvents: () => events, append: (type, data, options) => events.push({ type, data, ...options }) }
  seen.created({ agent: { ctx: { tools }, session } })
  seen.created({ agent: { ctx: { tools }, session } })
  assert.deepEqual(events, [{ type: ASSISTANT_MODE_EVENT, data: { version: 1 }, ignorable: true }])
  assert.deepEqual(seen.allow, RABI_ASSISTANT_TOOL_NAMES)
  for (const name of ['web_search', 'web_fetch']) assert.equal(seen.guard({ name, arguments: {} }), undefined)
  for (const name of ['pwsh', 'read_file', 'write_file', 'browser', 'skill', 'run_code', 'subagent', 'future_tool', 'rabiroute_fake']) {
    assert.match(seen.guard({ name, arguments: {} }), /禁止/)
  }
  assert.equal(seen.guard({ name: 'rabiroute_manager_api', arguments: { method: 'GET', path: '/api/roles/r/persona-document' } }), undefined)
  assert.equal(seen.promptOrder, 9800)
  assert.match(seen.prompt, /session-test/)
  assert.match(seen.prompt, /人格由 Rabi 当前绑定/)
  assert.match(seen.prompt, /联网搜索 web_search 和网页读取 web_fetch/)
  assert.doesNotMatch(seen.prompt, /所有具体业务工作都交给其他 Agent/)
  assert.match(assistantModePrompt(), /不能猜测身份/)
  assert.throws(() => apply({ tools: {} }), /请先更新宿主/)
})

test('direct user input allows one search and requires a visible reply before dispatch', async () => {
  const events = new Map()
  let guard
  const tools = {
    guard: listener => { guard = listener },
    restrict() {},
    register() {},
    get: name => ({ name, execute() {} }),
  }
  apply({ tools, on: (name, listener) => events.set(name, listener), systemPrompt: { section() {} } })
  const agent = {}
  const enter = (turn, kind) => events.get('agent/pre-step')({ agent, turn }, async () => ({
    kind: 'enter', messages: kind === undefined ? [] : [{ source: { kind } }],
  }))
  const toolSet = {}
  const call = (name, args) => guard({ agent, toolSet, name, arguments: args })
  const send = { requestJson: '{"action":"send","responsePolicy":"required"}' }
  const search = { method: 'GET', path: '/api/search?q=fixture' }
  await enter(1, 'user')
  assert.equal(call('rabiroute_manager_api', search), undefined)
  assert.match(call('web_search'), /先用 rabiroute_assistant_say/)
  assert.equal(call('rabiroute_manager_api', { method: 'GET', path: '/api/personas' }), undefined)
  assert.equal(call('rabiroute_agent_threads', { requestJson: '{"action":"read"}' }), undefined)
  assert.match(call('rabiroute_agent_threads', send), /先用 rabiroute_assistant_say/)
  assert.match(call('rabiroute_manager_api', { method: 'POST', path: '/api/agent/threads' }), /先用 rabiroute_assistant_say/)
  assert.match(call('rabiroute_assistant_delegate'), /先用 rabiroute_assistant_say/)
  const speech = { agent, toolSet, name: 'rabiroute_assistant_say' }
  events.get('tools/result')(speech, { isError: true })
  await enter(1)
  assert.match(call('rabiroute_assistant_delegate'), /先用 rabiroute_assistant_say/)
  events.get('tools/result')(speech, { isError: false, value: { text: '我来查一下。' } })
  assert.match(call('rabiroute_assistant_delegate'), /先用 rabiroute_assistant_say/)
  await enter(1)
  assert.equal(call('rabiroute_assistant_delegate'), undefined)
  assert.equal(call('rabiroute_agent_threads', send), undefined)
  await enter(1, 'user')
  assert.equal(call('web_search'), undefined)
  assert.match(call('rabiroute_manager_api', search), /先用 rabiroute_assistant_say/)
  await enter(2, 'subagent-settled')
  assert.equal(call('rabiroute_assistant_delegate'), undefined)
})

test('business delegation yields only on confirmed acceptance with a formal return path', () => {
  const args = { requestJson: JSON.stringify({ action: 'send', responsePolicy: 'required' }) }
  const result = { ok: true, statusCode: 200, body: JSON.stringify({ code: 0, delivery: { status: 'accepted' } }) }
  assert.equal(acceptedBackgroundThread('rabiroute_agent_threads', args, result), true)
  assert.equal(acceptedBackgroundThread('rabiroute_manager_api', { method: 'POST', path: '/api/agent/threads', bodyJson: args.requestJson }, result), true)
  assert.equal(acceptedBackgroundThread('rabiroute_manager_api', { method: ' post ', path: '/api/agent/threads?source=fixture', bodyBase64: Buffer.from(args.requestJson).toString('base64') }, result), true)
  for (const value of [
    { ...result, ok: false }, { ...result, uncertain: true }, { ...result, statusCode: 202 },
    { ...result, body: 'invalid' }, { ...result, body: JSON.stringify({ code: 0, uncertain: true, delivery: { status: 'accepted' } }) },
    { ...result, body: JSON.stringify({ code: 0, delivery: { status: 'delivery_unconfirmed' } }) },
    { ...result, body: JSON.stringify({ code: 1, delivery: { status: 'accepted' } }) },
  ]) assert.equal(acceptedBackgroundThread('rabiroute_agent_threads', args, value), false)
  for (const request of [{ action: 'read', responsePolicy: 'required' }, { action: 'send', responsePolicy: 'none' }, { action: 'create' }]) {
    assert.equal(acceptedBackgroundThread('rabiroute_agent_threads', { requestJson: JSON.stringify(request) }, result), false)
  }
})

test('background delegation concludes only after acceptance and leaves result delivery to DSH', async () => {
  let accept, concludes = 0, request
  const ctx = { subagents: {
    resolveMaxDepth: () => 2,
    startActivation: value => { request = value; return new Promise(resolve => { accept = resolve }) },
  } }
  const tool = assistantToolDefinitions(ctx).find(tool => tool.name === 'rabiroute_assistant_delegate')
  const agent = { id: 'parent' }, signal = new AbortController().signal
  const pending = tool.execute({ description: '查表', prompt: '读取指定表并回报行号', name: 'lookup', cwd: 'C:/fixture' }, { agent, signal, concludeTurn: () => { concludes++ } })
  assert.equal(concludes, 0)
  assert.deepEqual(request, { provider: 'spawn', agentPreset: 'standard', parent: agent, label: '查表', prompt: [{ type: 'text', text: '读取指定表并回报行号' }], name: 'lookup', cwd: 'C:/fixture', maxDepth: 2, signal, delivery: 'parent' })
  accept({ childId: 'child', name: 'lookup', messageId: 'accepted-message', get result() { assert.fail('delegation must not await child completion') } })
  assert.deepEqual(await pending, { childId: 'child', name: 'lookup', messageId: 'accepted-message' })
  assert.equal(concludes, 1)
})

test('failed admission keeps the current turn and speech returns complete replayable text', async () => {
  let concludes = 0
  const error = new Error('admission failed')
  const definitions = assistantToolDefinitions({ subagents: { resolveMaxDepth: () => 1, startActivation: async () => { throw error } } })
  await assert.rejects(definitions[1].execute({ description: 'lookup', prompt: 'task' }, { agent: {}, signal: new AbortController().signal, concludeTurn: () => { concludes++ } }), error)
  assert.equal(concludes, 0)
  const text = '完整回复\n[来源](https://example.test/table)'
  const value = await definitions[0].execute({ text }, {})
  assert.deepEqual(value, { text })
  assert.deepEqual(JSON.parse(definitions[0].output.render({}, value)[0].text), { text })
  assert.deepEqual(definitions[0].output.presentationMeta({}, value), { kind: 'rabi-assistant-say', text })
  const silent = await definitions[0].execute({ text: '', staySilent: true }, { concludeTurn: () => { concludes++ } })
  assert.deepEqual(silent, { text: '', staySilent: true })
  assert.deepEqual(definitions[0].output.presentationMeta({}, silent), { kind: 'rabi-assistant-silence' })
  assert.equal(concludes, 1)
})

test('assistant mode shares staged discovery instructions with the host prompt and packaged source', async () => {
  const { readFile } = await import('node:fs/promises')
  const { internals, RABIROUTE_API_DISCOVERY_PROMPT } = await import('../lib/index.js')
  assert.equal(typeof RABIROUTE_API_DISCOVERY_PROMPT, 'string')
  assert.ok(assistantModePrompt().includes(RABIROUTE_API_DISCOVERY_PROMPT))
  assert.ok(internals.promptText({}).includes(RABIROUTE_API_DISCOVERY_PROMPT))
  assert.doesNotMatch(assistantModePrompt(), /接口合同先通过 GET \/api\/agent\/help/)
  for (const name of ['index.js', 'assistant-mode.js']) {
    assert.equal(await readFile(new URL('../src/' + name, import.meta.url), 'utf8'), await readFile(new URL('../lib/' + name, import.meta.url), 'utf8'))
  }
})

test('new user steering takes precedence over a pending schedule repair', async () => {
  const listeners = new Map()
  const guards = []
  const events = []
  const notices = []
  const ctx = {
    tools: { restrict() {}, guard: handler => guards.push(handler), register() {}, get: name => ({ name }) },
    on: (name, handler) => listeners.set(name, [...(listeners.get(name) ?? []), handler]),
    systemPrompt: { section() {} },
  }
  apply(ctx)
  const agent = {
    steer: message => notices.push(message),
    session: {
      append: (type, data, options) => events.push({ type, data, ...options }),
      snapshotEvents: () => events,
    },
  }
  const enter = (turn, messages) => listeners.get('agent/pre-step').reduceRight(
    (next, handler) => () => handler({ agent, turn, messages }, next),
    async () => ({ kind: 'enter', messages }),
  )()
  const stopping = (turn, signal) => {
    for (const handler of listeners.get('agent/turn-stopping')) handler({ agent, turn, signal })
  }
  const trigger = { id: 'schedule', source: { kind: 'schedule' } }
  const user = { id: 'new-input', source: { kind: 'user' } }
  const signal = new AbortController().signal
  await enter(1, [trigger])
  stopping(1, signal)
  assert.equal(notices.length, 1)
  const admitted = await enter(1, [notices[0], user])
  assert.deepEqual(admitted.messages, [user])
  assert.deepEqual(events.map(({ type, data }) => [type, data.turn]), [['rabiroute/assistant-schedule-reply', 1]])
  assert.equal(guards[0]({ agent, toolSet: {}, name: 'rabiroute_manager_api' }), undefined)
  await enter(2, [user])
  assert.equal(guards[0]({ agent, toolSet: {}, name: 'rabiroute_assistant_say', arguments: { text: '', staySilent: true } }), undefined)
  const aborted = new AbortController()
  await enter(3, [trigger])
  aborted.abort()
  stopping(3, aborted.signal)
  assert.equal(notices.length, 1)
  for (const handler of listeners.get('agent/status')) handler({ agent, status: 'idle' })
  assert.equal(events.length, 1)
})
