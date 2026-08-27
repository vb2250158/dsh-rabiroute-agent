import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, createRabiRouteAgentRuntimeStatus, internals } from '../lib/index.js'

function harness() {
  const tools = new Map()
  const sections = []
  const listeners = new Map()
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { section(section) { sections.push(section); return () => {} } },
    inject(_services, callback) { callback(ctx) },
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name) },
  }
  return { ctx, tools, sections, listeners }
}

test('registers RabiRoute tools, prompt, and communication guard', () => {
  const state = harness()
  apply(state.ctx, { managerBaseUrl: 'http://127.0.0.1:8790', enforceAgentCommunication: true })
  assert.deepEqual([...state.tools.keys()], ['rabiroute_agent_threads', 'rabiroute_agent_send', 'rabiroute_manager_api'])
  assert.match(state.sections[0].text, /DSH 会话可以作为 RabiRoute 的主人格/)
  const guard = state.listeners.get('tools/pre-execute')
  return guard({ name: 'pwsh', arguments: { command: 'curl http://127.0.0.1:8790/api/agent/threads' } }, async () => ({ kind: 'allow' }))
    .then(result => assert.deepEqual(result, { kind: 'deny', reason: 'Use the RabiRoute plugin tools for Agent communication and external sending.' }))
})

test('reports the live RabiRoute plugin contract', () => {
  const status = createRabiRouteAgentRuntimeStatus({
    managerBaseUrl: 'http://127.0.0.1:8790/',
    enforceAgentCommunication: true,
    requestTimeoutMs: 45000,
  })
  assert.deepEqual(status, {
    id: 'rabiroute-agent',
    name: 'RabiRoute Agent',
    version: '0.1.2',
    active: false,
    managerBaseUrl: 'http://127.0.0.1:8790',
    enforceAgentCommunication: true,
    requestTimeoutMs: 45000,
    tools: ['rabiroute_agent_threads', 'rabiroute_agent_send', 'rabiroute_manager_api'],
  })
  const state = harness()
  const active = apply(state.ctx, { managerBaseUrl: 'http://127.0.0.1:8790' })
  assert.equal(active.active, true)
})

test('thread tool emits the messageSource contract and forwards the authoritative response', async () => {
  const state = harness()
  apply(state.ctx, {})
  let captured
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body)
    return new Response(JSON.stringify({ code: 0, status: 'delivered' }), { status: 202, headers: { 'content-type': 'application/json' } })
  }
  try {
    const tool = state.tools.get('rabiroute_agent_threads')
    const result = await tool.execute({ requestJson: JSON.stringify({
      action: 'send',
      agentAdapter: 'dsh',
      threadId: 'session-11111111-1111-1111-1111-111111111111',
      prompt: '继续处理',
      cwd: 'C:/workspace',
      sourceThreadId: 'session-22222222-2222-2222-2222-222222222222',
      sourceAgentType: 'plan_secretary',
      responsePolicy: 'none',
      deliverySource: {
        agentAdapter: 'dsh',
        sessionId: 'session-22222222-2222-2222-2222-222222222222',
        sessionName: '计划秘书',
      },
    }) }, { signal: new AbortController().signal })
    assert.equal(captured.messageSource.type, 'agent')
    assert.equal(captured.messageSource.agentType, 'plan_secretary')
    assert.equal('deliverySource' in captured, false)
    assert.equal(result.statusCode, 202)
    assert.match(result.body, /delivered/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('manager tool rejects arbitrary paths and dedicated delivery endpoints', async () => {
  const definitions = internals.toolDefinitions({ managerBaseUrl: 'http://127.0.0.1:8790', requestTimeoutMs: 30000 })
  const tool = definitions.find(item => item.name === 'rabiroute_manager_api')
  await assert.rejects(() => tool.execute({ method: 'GET', path: '/api/config', bodyJson: '' }, { signal: new AbortController().signal }), /outside/)
  await assert.rejects(() => tool.execute({ method: 'POST', path: '/api/agent/send', bodyJson: '{}' }, { signal: new AbortController().signal }), /outside|rabiroute_agent_send/)
})
