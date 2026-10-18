import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installNativeHooks } from '../src/native-hooks.js'
const profile = createRequire(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/web/package.json'))
const { Context } = profile('@deepseek-ai/cordis')
const SessionStore = profile('@deepseek-ai/dsh-session').default
const { createAssistantMessage } = profile('@deepseek-ai/dsh-llm')
const { sessionFormatCatalog } = profile('@deepseek-ai/dsh-session-format-catalog')

async function fixture(reply) {
  const root = new Context()
  await root.plugin(SessionStore)
  const session = root.sessions.create()
  session.append('turn/start', { turn: 1 })
  const handlers = new Map(), effects = [], requests = [], injected = [], steered = [], warnings = []
  const agent = { id: 'runtime-id', session, inject: value => injected.push(value), steer: value => steered.push(value) }
  const ctx = { effect: callback => effects.push(callback()), on: (point, listener) => handlers.set(point, listener),
    workingDirectory: { get: () => 'test-workspace' }, sessionProjections: { stateOf: () => ({ lastTurn: 1 }) },
    logger: { warn: (...args) => warnings.push(args) } }
  const hooks = installNativeHooks(ctx, {}, { request: async (_config, path, options, signal) => {
    const body = JSON.parse(options.body); requests.push({ path, body, signal })
    return reply ? reply(body, signal) : { ok: true, statusCode: 200, body: JSON.stringify({ code: 0, data: { additionalContext: 'context from Rabi' } }) }
  } })
  return { session, handlers, requests, agent, injected, steered, warnings, hooks,
    records: () => session.snapshotEvents().filter(event => event.type.startsWith('plugin:')),
    dispose: async () => { for (const effect of effects.reverse()) await effect?.(); await root.fiber.dispose() } }
}

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
