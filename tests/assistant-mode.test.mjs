import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, assistantModePrompt } from '../lib/assistant-mode.js'
import { apply as hostApply, RABIROUTE_AGENT_TOOL_NAMES } from '../lib/index.js'
import { rabiAssistantPreset } from '../lib/assistant-preset.js'

test('installed plugin registers a portable Rabi assistant preset and owns its disposal', async () => {
  const rows = [], effects = []
  const ctx = {
    effect: fn => effects.push(fn()),
    agentPresets: { register: async row => { rows.push(row); return () => rows.pop() } },
    inject: (names, fn) => { if (names.every(name => name in ctx)) fn(ctx) },
  }
  hostApply(ctx, {})
  assert.deepEqual(rows, [rabiAssistantPreset])
  assert.equal(rows[0].id, 'rabi-assistant')
  assert.equal(rows[0].name, 'Rabi助手模式')
  assert.deepEqual(rows[0].plugins.map(row => row.name), ['@deepseek-ai/dsh-persona', 'dsh-rabiroute-agent/assistant-mode'])
  for (const effect of effects) (await effect)?.()
  assert.equal(rows.length, 0)
})

test('assistant hides and denies non-Rabi tools while preserving persona conversation', () => {
  const seen = {}
  apply({ tools: {
    restrict: value => { seen.allow = value.allow },
    guard: value => { seen.guard = value },
    presentAs: value => { seen.presentation = value },
  }, systemPrompt: { section: value => { seen.prompt = value.text({ agent: { session: { id: 'session-test' } } }) } } })
  assert.deepEqual(seen.allow, RABIROUTE_AGENT_TOOL_NAMES)
  assert.equal(seen.presentation, 'native')
  for (const name of ['pwsh', 'read_file', 'write_file', 'browser', 'skill', 'run_code', 'subagent', 'future_tool', 'rabiroute_fake']) {
    assert.match(seen.guard({ name, arguments: {} }), /禁止/)
  }
  assert.equal(seen.guard({ name: 'rabiroute_manager_api', arguments: { method: 'GET', path: '/api/roles/r/persona-document' } }), undefined)
  assert.match(seen.prompt, /session-test/)
  assert.match(seen.prompt, /人格由 Rabi 当前绑定/)
  assert.doesNotMatch(seen.prompt, /所有具体业务工作都交给其他 Agent/)
  assert.match(assistantModePrompt(), /不能猜测身份/)
  assert.throws(() => apply({ tools: {} }), /请先更新宿主/)
})
