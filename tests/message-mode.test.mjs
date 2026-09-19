import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { messageModeGuard, messageModePrompt, apply } from '../lib/message-mode.js'
import { RABIROUTE_AGENT_TOOL_NAMES, internals } from '../lib/index.js'

const call = (name, request) => ({ name, arguments: { requestJson: JSON.stringify(request) } })

test('message mode rejects every non-Rabi tool including future plugin names', () => {
  for (const name of ['cmd', 'bash', 'pwsh', 'terminal', 'read_file', 'write_file', 'apply_patch', 'glob', 'grep', 'skill', 'run_code', 'workflow', 'subagent', 'rabiroute_fake', 'future_tool']) {
    assert.match(messageModeGuard(call(name, {})), /禁止/)
  }
})

test('thread communication and task routing retain workspace metadata', () => {
  for (const action of ['list', 'read', 'create', 'send', 'rename', 'resolve']) {
    assert.equal(messageModeGuard(call('rabiroute_agent_threads', { action, workspace: 'C:/project', message: 'Please inspect file path in your own task.' })), undefined)
  }
  assert.equal(messageModeGuard(call('rabiroute_agent_send', { payload: { type: 'text', text: 'hello' } })), undefined)
})

test('file content and attachment APIs cannot bypass the mode through Rabi', () => {
  for (const request of [
    { attachments: [{ id: 'file' }] }, { payload: { type: 'file', url: 'https://example.org/file' } },
    { payload: { localPath: 'C:/secret' } }, { payload: { path: 'C:/secret' } },
    { payload: { contentBase64: 'YQ==' } }, { payload: { type: 'localImage' } }, { imagePaths: ['C:/secret.png'] },
  ]) assert.match(messageModeGuard(call('rabiroute_agent_send', request)), /禁止/)
  assert.match(messageModeGuard({ name: 'rabiroute_manager_api', arguments: { method: 'GET', path: '/api/roles/r/plans/p/attachments/a' } }), /禁止/)
  assert.match(messageModeGuard({ name: 'rabiroute_manager_api', arguments: { method: 'POST', path: '/api/roles/r/plans', bodyJson: '{"attachments":[{"path":"C:/secret"}]}' } }), /禁止/)
})

test('all plan operations, message processing and persona messaging stay available', () => {
  for (const [method, path] of [
    ['GET', '/api/message-processing/board'], ['POST', '/api/message-processing/requirements/r/outcome'],
    ['GET', '/api/roles/r/plans'], ['POST', '/api/roles/r/plans'], ['PATCH', '/api/roles/r/plans/p'],
    ['DELETE', '/api/roles/r/plans/p'], ['POST', '/api/roles/r/plans/p/feedback'],
    ['GET', '/api/roles/r/plan-statuses'], ['POST', '/api/roles/r/plan-marker-statuses'],
    ['GET', '/api/personas?addressable=true'], ['GET', '/api/personas/p'],
    ['POST', '/api/personas/p/messages'], ['GET', '/api/personas/messages/receipts/id'],
    ['GET', '/api/agent/requests/id'], ['GET', '/api/agent/send/receipts/id'],
    ['GET', '/api/roles/r/skills'], ['GET', '/api/roles/r/skills/coordination'],
    ['GET', '/api/roles/r/persona-document'], ['GET', '/api/codex-hook/sessions/current'],
    ['GET', '/api/roles/r/memory/recent'], ['GET', '/api/roles/r/memory/recent/m'],
    ['GET', '/api/roles/r/memory/consolidated/m'], ['POST', '/api/roles/r/memory/recent'],
    ['PATCH', '/api/roles/r/memory/recent/m'], ['POST', '/api/roles/r/memory/consolidation-requests'],
  ]) assert.equal(messageModeGuard({ name: 'rabiroute_manager_api', arguments: { method, path } }), undefined, path)
  assert.throws(() => internals.validatePath('/api/personas/p/messages', 'GET'), /POST/)
  assert.throws(() => internals.validatePath('/api/personas/p', 'DELETE'), /GET-only/)
  assert.throws(() => internals.validatePath('/api/codex-hook/sessions/current', 'PUT'), /GET-only/)
})

test('mount uses the scoped catalog, native tools and a monotonic execution guard', () => {
  const seen = {}
  apply({ tools: {
    restrict: value => { seen.restriction = value }, presentAs: value => { seen.mode = value },
    guard: value => { seen.guard = value },
  }, systemPrompt: { section: value => { seen.prompt = value.text() } } })
  assert.deepEqual(seen.restriction.allow, RABIROUTE_AGENT_TOOL_NAMES)
  assert.equal(seen.mode, 'native')
  assert.equal(seen.guard, messageModeGuard)
  assert.match(seen.prompt, /所有具体业务工作都交给其他 Agent/)
  assert.throws(() => apply({ tools: {} }), /请先更新宿主/)
})

test('coordination guidance supplies per-session identity and Rabi skill/memory instructions', () => {
  const first = messageModePrompt({ agent: { session: { id: 'first', header: { cwd: 'C:/project' } } } })
  const second = messageModePrompt({ agent: { session: { id: 'second', header: { cwd: 'C:/other' } } } })
  assert.match(first, /"sessionId":"first"/)
  assert.doesNotMatch(second, /"sessionId":"first"/)
  assert.match(second, /"sessionId":"second"/)
  assert.match(first, /skills\/<skillId>/)
  assert.match(first, /memory\/consolidated/)
  assert.match(first, /加载 Skill 不扩大本模式权限/)
  assert.match(messageModePrompt(), /不要伪造投递来源/)
})

test('packaged preset names the picker mode without mounting file or coding plugins', async () => {
  const root = new URL('../', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(manifest.exports['./message-mode'], './lib/message-mode.js')
  assert.ok(manifest.files.includes('presets'))
  const preset = await readFile(new URL('presets/message-processing/agent.cordis.yml', root), 'utf8')
  assert.deepEqual([...preset.matchAll(/name: (.+)/g)].map(match => match[1]), ["'@deepseek-ai/dsh-persona'", 'dsh-rabiroute-agent/message-mode'])
  assert.match(preset, /includeRuntimeContext: false/)
  assert.match(await readFile(new URL('presets/message-processing/preset.yml', root), 'utf8'), /name: 消息处理模式/)
  assert.equal(await readFile(new URL('src/message-mode.js', root), 'utf8'), await readFile(new URL('lib/message-mode.js', root), 'utf8'))
})
