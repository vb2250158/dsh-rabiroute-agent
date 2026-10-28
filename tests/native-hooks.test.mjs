import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { installNativeHooks } from '../src/native-hooks.js'
const profile = createRequire(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/web/package.json'))
const { Context } = profile('@deepseek-ai/cordis')
const SessionStore = profile('@deepseek-ai/dsh-session').default
const { createAssistantMessage } = profile('@deepseek-ai/dsh-llm')
const { sessionFormatCatalog } = profile('@deepseek-ai/dsh-session-format-catalog')
const okContext = text => ({ ok: true, statusCode: 200, body: JSON.stringify({ code: 0, data: { binding: { roleId: 'fixture' }, additionalContext: text } }) })
const offline = () => ({ ok: false, statusCode: 503, error: { message: 'offline' } })
const step = (f, turn = 1, signal = new AbortController().signal) => f.handlers.get('agent/pre-step')({ agent: f.agent, messages: [{ content: [{ type: 'text', text: 'hello' }] }], turn, signal }, async () => ({ kind: 'enter', messages: [] }))
async function cachedFixture(t, reply, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hook-offline-'))
  const f = await fixture(reply, { ...options, config: { hookContextCacheFile: join(dir, 'cache.json'), hookContextForegroundMs: 1000, ...options.config } })
  t.after(async () => { await f.dispose(); await rm(dir, { recursive: true, force: true }) })
  f.unlink = f.hooks.requireBinding(f.session.id, 'fixture', { allowCachedContext: true, ...options.binding })
  return f
}

test('confirmed context permits ordinary offline replies but grants no tool permission or Stop receipt', async t => {
  let connected = true
  const f = await cachedFixture(t, () => connected ? okContext('confirmed fixture persona') : offline())
  await step(f)
  connected = false
  const result = await step(f, 2)
  assert.match(result.messages[0].content[0].text, /confirmed fixture persona/)
  assert.match(result.messages[0].content[0].text, /历史快照/)
  assert.equal(f.hooks.statusOf(f.session.id).state, 'cached')
  assert.doesNotMatch(JSON.stringify(f.records()), /confirmed fixture persona/)
  const before = f.requests.length
  await f.handlers.get('agent/turn-stopping')({ agent: f.agent, turn: 2 })
  assert.equal(f.requests.length, before, 'pending recovery does not send another lifecycle write')
  assert.equal(f.hooks.statusOf(f.session.id).state, 'sync_unconfirmed')
  assert.equal(f.steered.length, 0)
  await assert.rejects(f.handlers.get('tools/pre-execute')({ agent: f.agent, name: 'test' }, async () => assert.fail('offline permission must not execute')), /Rabi binding PreToolUse failed/)
})

test('cold cache and a slow binding lookup do not block conversation or start duplicate requests', async t => {
  let release
  const wait = new Promise(resolve => { release = resolve })
  const f = await cachedFixture(t, () => okContext('new confirmed context'), { config: { hookContextForegroundMs: 10 }, binding: { prepareContext: () => wait } })
  try {
    const result = await step(f)
    assert.match(result.messages[0].content[0].text, /没有有效的已确认快照/)
    assert.equal(f.requests.length, 0)
    await step(f, 2)
    assert.equal(f.requests.length, 0)
    release()
    for (let i = 0; i < 50 && f.requests.length === 0; i++) await new Promise(resolve => setImmediate(resolve))
  } finally { release() }
})

test('explicit binding conflict, authentication rejection and malformed context cannot use an old snapshot', async t => {
  for (const failure of [
    { ok: false, statusCode: 403, error: { message: 'denied' } },
    { ok: true, statusCode: 200, body: JSON.stringify({ code: 0, data: { binding: { roleId: 'other' }, additionalContext: 'wrong role' } }) },
    { ok: true, statusCode: 200, body: JSON.stringify({ code: 0, data: { binding: { roleId: 'fixture' }, additionalContext: {} } }) },
  ]) {
    let response = okContext('old snapshot')
    const f = await cachedFixture(t, () => response)
    await step(f); response = failure
    await assert.rejects(step(f, 2), /Rabi binding UserPromptSubmit failed/)
    assert.equal(f.hooks.statusOf(f.session.id).state, 'failed')
  }
})

test('cancellation and unlink during refresh never admit late context', async t => {
  let release
  const f = await cachedFixture(t, () => new Promise(resolve => { release = resolve }))
  const controller = new AbortController()
  const pending = step(f, 1, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('user cancelled'))
  release(okContext('late context'))
  await assert.rejects(pending, /cancel|aborted/)
  const next = step(f, 2)
  await new Promise(resolve => setImmediate(resolve))
  f.unlink({ forgetContext: true }); release(okContext('late unlinked context'))
  await assert.rejects(next, /binding changed|no longer enabled/)
})

test('a strict owner keeps binding verification mandatory even when another owner permits cache', async t => {
  const f = await cachedFixture(t, offline)
  const release = f.hooks.requireBinding(f.session.id, 'fixture')
  try { await assert.rejects(step(f), /Rabi binding SessionStart failed/) } finally { release() }
})

test('an uncertain binding preparation preserves its uncertainty without dispatching a Hook', async t => {
  const f = await cachedFixture(t, () => assert.fail('Hook must not dispatch'), { binding: { prepareContext: async () => {
    throw Object.assign(new Error('binding outcome uncertain'), { offlineEligible: true, uncertain: true, code: 'fixture/uncertain' })
  } } })
  await step(f)
  assert.equal(f.requests.length, 0)
  const result = f.records().find(value => value.type.endsWith('hook-result'))
  assert.equal(result.data.uncertain, true)
  assert.equal(result.data.failureKind, 'fixture/uncertain')
})

test('a slow Stop does not hide a completed reply and its confirmed late continuation is applied once', async t => {
  let release
  const f = await cachedFixture(t, body => body.eventName === 'Stop'
    ? new Promise(resolve => { release = resolve }) : okContext('confirmed'), { config: { hookContextForegroundMs: 10 }, dependencies: {
      contextCache: { get: async () => null, remember: async () => {}, forget: async () => {}, flush: async () => {} },
    } })
  await step(f)
  try {
    await f.handlers.get('agent/turn-stopping')({ agent: f.agent, turn: 1 })
    assert.equal(f.hooks.statusOf(f.session.id).state, 'sync_unconfirmed')
    assert.equal(f.requests.filter(value => value.body.eventName === 'Stop').length, 1)
    release({ ok: true, statusCode: 200, body: JSON.stringify({ code: 0, data: { binding: { roleId: 'fixture' }, followup: { decision: 'block', reason: 'confirmed followup' } } }) })
    for (let i = 0; i < 50 && !f.steered.length; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.steered.length, 1)
    assert.match(f.steered[0].content[0].text, /confirmed followup/)
  } finally { release?.(okContext('')) }
})

test('expired full context triggers a fresh SessionStart and cannot be renewed by prompt deltas', async t => {
  let now = 10000
  const f = await cachedFixture(t, () => okContext('confirmed'), { config: { hookContextCacheMaxAgeMs: 1000 }, dependencies: { clock: () => now } })
  await step(f)
  now += 1001
  await step(f, 2)
  assert.deepEqual(f.requests.map(value => value.body.eventName), ['SessionStart', 'UserPromptSubmit', 'SessionStart', 'UserPromptSubmit'])
})

test('new queued input supersedes a late Stop continuation without replaying the Stop', async t => {
  let release
  const f = await cachedFixture(t, body => body.eventName === 'Stop'
    ? new Promise(resolve => { release = resolve }) : okContext('confirmed'), { config: { hookContextForegroundMs: 10 }, dependencies: {
      contextCache: { get: async () => null, remember: async () => {}, forget: async () => {}, flush: async () => {} },
    } })
  await step(f)
  await f.handlers.get('agent/turn-stopping')({ agent: f.agent, turn: 1 })
  f.agent.inbox = { nextTurn: [{ content: 'new user input' }] }
  release({ ok: true, statusCode: 200, body: JSON.stringify({ code: 0, data: { binding: { roleId: 'fixture' }, followup: { decision: 'block', reason: 'old continuation' } } }) })
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.steered.length, 0)
  assert.equal(f.requests.filter(value => value.body.eventName === 'Stop').length, 1)
})

test('a workspace change while a request is pending cannot store context under the new directory', async t => {
  let release
  const f = await cachedFixture(t, () => new Promise(resolve => { release = resolve }))
  const pending = step(f)
  await new Promise(resolve => setImmediate(resolve))
  f.ctx.workingDirectory.get = () => 'other-workspace'
  release(okContext('context from old workspace'))
  await assert.rejects(pending, /workspace changed/)
})

async function fixture(reply, options = {}) {
  const root = new Context()
  await root.plugin(SessionStore)
  const session = root.sessions.create()
  session.append('turn/start', { turn: 1 })
  const handlers = new Map(), effects = [], requests = [], injected = [], steered = [], warnings = []
  const agent = { id: 'runtime-id', session, inject: value => injected.push(value), steer: value => steered.push(value) }
  const ctx = { effect: callback => effects.push(callback()), on: (point, listener) => handlers.set(point, listener),
    workingDirectory: { get: () => 'test-workspace' }, sessionProjections: { stateOf: () => ({ lastTurn: 1 }) },
    logger: { warn: (...args) => warnings.push(args) } }
  const hooks = installNativeHooks(ctx, options.config ?? {}, { ...options.dependencies, request: async (_config, path, requestOptions, signal, timing) => {
    const body = JSON.parse(requestOptions.body); requests.push({ path, body, signal })
    return reply ? reply(body, signal, timing) : { ok: true, statusCode: 200, body: JSON.stringify({ code: 0, data: { additionalContext: 'context from Rabi' } }) }
  } })
  return { session, handlers, requests, agent, injected, steered, warnings, hooks, ctx,
    records: () => session.snapshotEvents().filter(event => event.type.startsWith('plugin:')),
    dispose: async () => { for (const effect of effects.reverse()) await effect?.(); await root.fiber.dispose() } }
}

test('Hook diagnostic records retain transport substeps and omit prompt and context content', async () => {
  const f = await fixture((_body, _signal, timing) => {
    timing.onTiming({ path: ['host-discovery'], startMs: 0, durationMs: 1 })
    return okContext('private-context-never-in-telemetry')
  })
  try {
    await step(f)
    const results = f.records().filter(row => row.type.endsWith('hook-result'))
    assert.equal(results.length, 2)
    assert.ok(results.every(row => row.data.timings.some(part => part.path[0] === 'host-discovery')))
    assert.doesNotMatch(JSON.stringify(results), /private-context-never-in-telemetry/)
  } finally { await f.dispose() }
})

test('DSH lifecycle records real SessionStart, prompt, tool and Stop events with the owning session identity', async () => {
  const f = await fixture()
  try {
    f.handlers.get('agent/created')({ agent: f.agent, source: 'new' })
    const messages = [{ content: [{ type: 'text', text: 'hello' }] }]
    const signal = new AbortController().signal
    const enter = await f.handlers.get('agent/pre-step')({ agent: f.agent, messages, turn: 1, signal }, async () => ({ kind: 'enter', messages }))
    assert.equal(enter.messages.length, 2)
    const contexts = [enter.messages[1]]
    await f.handlers.get('agent/pre-step')({ agent: f.agent, messages: [enter.messages[1]], turn: 1, signal }, async () => ({ kind: 'enter', messages: [enter.messages[1]] }))
    const exec = { agent: f.agent, name: 'test_tool', arguments: { value: 'private-input' }, callId: 'call-1', signal }
    await f.handlers.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }))
    await f.handlers.get('tools/post-execute')(exec, { content: [{ type: 'text', text: 'private-output' }] }, async () => ({ kind: 'pass' }))
    const message = createAssistantMessage({ content: [{ type: 'text', text: 'finished' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } })
    f.session.append('assistant/message', { turn: 1, step: 0, message, stream: [] }, { surfaceOp: 'append' })
    f.handlers.get('session/event')(f.session, { type: 'assistant/message', data: { turn: 1, message } })
    await f.handlers.get('agent/turn-stopping')({ agent: f.agent, turn: 1, signal })
    contexts.push(...f.injected, ...f.steered)
    assert.ok(contexts.length >= 4)
    for (const message of contexts) {
      sessionFormatCatalog.encodeCurrentEvent({ type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: message })
      assert.equal(message.source.kind, 'dsh-rabiroute-agent')
    }
    assert.deepEqual(f.requests.map(item => item.body.eventName), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'])
    assert.ok(f.requests.every(item => item.body.agentType === 'dsh' && item.body.sessionId === f.session.id && item.body.turnId === '1'))
    assert.equal(f.requests.at(-1).body.lastAssistantMessage, 'finished')
    assert.equal(f.records().length, 10)
    assert.ok(f.records().every(event => event.ignorable === true))
    assert.doesNotMatch(JSON.stringify(f.records()), /private-input|private-output|context from Rabi/)
  } finally { await f.dispose() }
})

test('Manager tool rejection prevents execution and Stop continuation runs at most once per turn', async () => {
  const f = await fixture(body => ({ ok: true, statusCode: 200, body: JSON.stringify({ code: 0, data: body.eventName === 'PreToolUse'
    ? { toolDecision: { permissionDecision: 'deny', reason: 'Rabi rule' } } : { followup: { decision: 'block', reason: 'followup' }, additionalContext: 'continue context' } }) }))
  try {
    let ran = false
    const signal = new AbortController().signal
    const result = await f.handlers.get('tools/pre-execute')({ agent: f.agent, name: 'test', signal }, async () => { ran = true })
    assert.equal(result.kind, 'deny'); assert.equal(ran, false)
    for (let i = 0; i < 2; i++) await f.handlers.get('agent/turn-stopping')({ agent: f.agent, turn: 1, signal })
    assert.equal(f.steered.length, 1)
    assert.match(f.steered[0].content[0].text, /followup\ncontinue context/)
    assert.equal(f.requests.at(-1).body.stopHookActive, true)
    assert.equal(f.records()[1].data.outcome, 'blocked')
  } finally { await f.dispose() }
})

test('failed and uncertain responses are recorded without fabricated context or retries; unload cancels and drains pending requests', async () => {
  const f = await fixture(() => ({ ok: false, statusCode: 503, uncertain: true, error: { message: 'unavailable' } }))
  const result = await f.handlers.get('tools/pre-execute')({ agent: f.agent, name: 'test' }, async () => ({ kind: 'allow' }))
  assert.equal(result.kind, 'allow'); assert.equal(f.requests.length, 1); assert.equal(f.injected.length, 0)
  assert.equal(f.records()[1].data.outcome, 'failed'); assert.equal(f.records()[1].data.uncertain, true)
  await f.dispose()
  const pending = await fixture((_body, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
  const run = pending.handlers.get('tools/pre-execute')({ agent: pending.agent, name: 'test' }, async () => ({ kind: 'allow' }))
  await pending.dispose()
  assert.equal((await run).kind, 'allow'); assert.equal(pending.records().at(-1).data.outcome, 'failed')
})

test('required persona bindings fail closed and retry SessionStart without switching persona', async () => {
  let fail = true
  const f = await fixture(body => fail ? {ok:false,statusCode:503,error:{message:'offline'}} : {ok:true,statusCode:200,body:JSON.stringify({code:0,data:{binding:{roleId:'fixture'},additionalContext:'RABI_FULL_CONTEXT'}})})
  const release = f.hooks.requireBinding(f.session.id, 'fixture')
  const payload = {agent:f.agent,messages:[],turn:1,signal:new AbortController().signal}
  let entered = false
  try {
    await assert.rejects(f.handlers.get('agent/pre-step')(payload,async()=>({kind:'enter',messages:[]})),/Rabi binding SessionStart failed/)
    assert.equal(f.records().at(-1).data.outcome,'failed')
    fail=false
    const result=await f.handlers.get('agent/pre-step')(payload,async()=>({kind:'enter',messages:[]}))
    assert.match(result.messages[0].content[0].text,/RABI_FULL_CONTEXT/)
    assert.deepEqual(f.requests.map(x=>x.body.eventName),['SessionStart','SessionStart'])
    assert.throws(()=>f.hooks.requireBinding(f.session.id,'other'),/another Rabi persona/)
    release()
  } finally {await f.dispose()}
})

test('required binding rejects changed persona before tool execution and keeps independent owners', async () => {
  const f=await fixture(()=>({ok:true,statusCode:200,body:JSON.stringify({code:0,data:{binding:{roleId:'other'},additionalContext:'wrong persona'}})}))
  const first=f.hooks.requireBinding(f.session.id,'fixture'), second=f.hooks.requireBinding(f.session.id,'fixture')
  first()
  let executed=false
  try {
    await assert.rejects(f.handlers.get('tools/pre-execute')({agent:f.agent,name:'test'},async()=>{executed=true}),/binding changed/)
    assert.equal(executed,false);assert.equal(f.injected.length,0)
    second()
    await f.handlers.get('tools/pre-execute')({agent:f.agent,name:'test'},async()=>{executed=true;return {kind:'allow'}})
    assert.equal(executed,true)
  } finally {await f.dispose()}
})

test('required bindings do not treat failed Stop business receipts or uncertain success as completion', async () => {
  for(const data of [{planTaskCompletion:{status:'failed'}},{completionDeliveries:[{status:'failed'}]}]){
    const f=await fixture(()=>({ok:true,statusCode:200,body:JSON.stringify({code:0,data:{binding:{roleId:'fixture'},...data}})}));f.hooks.requireBinding(f.session.id,'fixture')
    try{await assert.rejects(f.handlers.get('agent/turn-stopping')({agent:f.agent,turn:1}),/failed lifecycle operation/);assert.equal(f.records().at(-1).data.outcome,'failed')}finally{await f.dispose()}
  }
  const f=await fixture(()=>({ok:true,statusCode:200,uncertain:true,body:JSON.stringify({code:0,data:{binding:{roleId:'fixture'},additionalContext:'unconfirmed'}})}));f.hooks.requireBinding(f.session.id,'fixture')
  try{await assert.rejects(f.handlers.get('tools/pre-execute')({agent:f.agent,name:'test'},async()=>({kind:'allow'})),/outcome is uncertain/);assert.equal(f.injected.length,0)}finally{await f.dispose()}
})


test('required-session Hook status is visible while waiting, retains a typed failure and clears on unlink', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(async () => { await waiting; return { ok: false, statusCode: 0, uncertain: false, error: { kind: 'host_stopped', message: 'Rabi is not running' } }; });
  const unlink = f.hooks.requireBinding(f.session.id, 'fixture');
  try {
    const pending = f.handlers.get('agent/pre-step')({ agent: f.agent, messages: [], turn: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.hooks.statusOf(f.session.id).state, 'running');
    assert.equal(f.hooks.statusOf(f.session.id).point, 'SessionStart');
    release();
    await assert.rejects(pending, error => error.code === 'rabi/host-stopped');
    assert.equal(f.hooks.statusOf(f.session.id).code, 'host_stopped');
    assert.equal(f.records().at(-1).data.failureKind, 'host_stopped');
    unlink();
    assert.equal(f.hooks.statusOf(f.session.id), null);
  } finally { release(); await f.dispose(); }
});
