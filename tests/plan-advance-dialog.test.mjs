import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = (await readFile(new URL('../src/client-plan-advance.js', import.meta.url), 'utf8'))
  .replace(/^import [^\r\n]*\r?\n/gmu, '').replace(/^export /gmu, '')

function nodes(value, type) {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(item => nodes(item, type))
  return [...(value.type === type ? [value] : []), ...nodes(value.children, type)]
}

test('advance settings explain dispatch and expose the persona description and editable status prompt', async () => {
  const states = [], effects = [], calls = []
  let cursor = 0
  const status = { key: 'analysis', label: '分析中', description: '核对需求与证据。', state: 'enabled', terminal: false, palette: { accent: '#123456' } }
  const rule = { enabled: true, prompt: '先核对反馈', action: 'inspect', condition: 'changed', cooldownMinutes: 10, maxRunsPerStep: 3 }
  const settings = { revision: 'revision-1', statuses: [status], roles: { paused: 'paused' }, policy: { enabled: true, startup: true, events: true, due: false, rules: { analysis: rule } } }
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] },
    useEffect: (fn, deps) => { const index = cursor++; const previous = states[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) { previous?.dispose?.(); effects.push(() => { states[index] = { deps, dispose: fn() } }) } },
  }
  const context = { React, Button: 'Button', Input: 'Input', Modal: 'Modal', URLSearchParams, AbortController, fetch: async (url, init) => {
    calls.push({ url, init })
    return { ok: true, json: async () => ({ code: 0, data: settings }) }
  } }
  vm.createContext(context)
  vm.runInContext(source + '\nthis.Dialog = RabiAdvanceDialog', context)
  const render = () => { cursor = 0; return context.Dialog({ cwd: 'C:\\example', roleIds: ['role-one'], mode: 'settings', t: () => '关闭', onClose() {} }) }
  render()
  while (effects.length) effects.shift()()
  await new Promise(resolve => setImmediate(resolve))
  let tree = render()
  assert.match(JSON.stringify(tree), /原绑定会话/)
  assert.match(JSON.stringify(tree), /核对需求与证据/)
  const field = nodes(tree, 'textarea')[0]
  assert.equal(field.props.value, '先核对反馈')
  field.props.onChange({ target: { value: '读取当前计划并核对反馈' } })
  tree = render()
  assert.equal(nodes(tree, 'textarea')[0].props.value, '读取当前计划并核对反馈')
  const save = nodes(tree, 'Button').find(node => node.children[0] === '保存')
  await save.props.onClick()
  assert.equal(JSON.parse(calls.at(-1).init.body).policy.rules.analysis.prompt, '读取当前计划并核对反馈')
})
