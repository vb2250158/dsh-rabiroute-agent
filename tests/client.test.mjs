import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const sources = await Promise.all(['message-envelope', 'client-locales', 'client-styles', 'client'].map(name => readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8')))
const code = sources.map(source => source.replace(/^import [^\r\n]*\r?\n/gmu, '').replace(/^export /gmu, '')).join('\n')
const raw = '[消息源]\r\n类型：Agent｜处理端：DSH\r\n会话：Test sender\r\n会话 ID：exact-id\r\n投递时间：2026-01-01\r\n\r\n[消息内容]\r\n  body @reference /skill\n\n[回传参数]\n{"deliveryId":"test","responsePolicy":"none"}'

function harness() {
  let states = [], cursor = 0
  const effects = [], projections = [], images = [], copied = [], opened = []
  const sessions = { refresh: async () => {}, list: { getSnapshot: () => ({ phase: 'ready', ids: ['exact-id'], byId: { 'exact-id': { id: 'exact-id' } } }) }, open: id => opened.push(id) }
  const React = { Fragment: 'Fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: initial => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] }, useRef: initial => { const index = cursor++; return states[index] ?? (states[index] = { current: initial }) }, useEffect: fn => { const index = cursor++; if (!(index in states)) { states[index] = true; effects.push(fn()) } } }
  const context = { React, Button: 'Button', Menu: 'Menu', Modal: 'Modal', JsonBlock: 'JsonBlock', projectUserText: (...args) => { projections.push(args); return { type: 'projected', children: [args[0]], props: {} } }, fileSizeText: bytes => `${bytes} B`, writeClipboard: async text => { copied.push(text); return true } }
  vm.createContext(context)
  vm.runInContext(`${code}\nthis.api = { apply, inject, RabiMessageNodeView, rabiContentParts, openRabiSender, rabiClientLocales }`, context)
  const t = (key, values = {}) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), context.api.rabiClientLocales.zh[key])
  const render = (content, kind = 'user', extras = {}) => { cursor = 0; return context.api.RabiMessageNodeView({ node: { kind, data: { content, time: 0, referenceLabels: ['reference'], skillNames: ['skill'], ...extras } }, t, rabiSessions: sessions, renderMessageImages: args => { images.push(args); return { type: 'image', props: args, children: [] } } }) }
  return { ...context.api, sessions, render, t, effects, projections, images, copied, opened }
}
function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, type))
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.children, type)]
}

test('ordinary user and steering preserve text, refs, skills, attachments, unknown JSON, clock and copy', async () => {
  for (const kind of ['user', 'steering']) {
    const h = harness()
    const content = [{ type: 'text', text: '  @reference' }, { type: 'text', text: ' /skill\n' }, { type: 'image', attachment: { attachmentId: 'image-id' } }, { type: 'file', attachment: { name: 'test.pdf', bytes: 23, mediaType: 'application/pdf' } }, { type: 'future', value: 1 }, null]
    const tree = h.render(content, kind)
    assert.equal(tree.props['data-rabi-message'], 'ordinary')
    assert.deepEqual(Array.from(h.projections[0]), ['  @reference /skill\n', ['reference'], ['skill']])
    assert.equal(h.images[0].images[0].attachment.attachmentId, 'image-id')
    assert.equal(h.images[0].compact, true)
    assert.equal(nodes(tree, 'JsonBlock').length, 2)
    assert.equal(nodes(tree, 'time')[0].props.dateTime, '1970-01-01T00:00:00.000Z')
    assert.ok(JSON.stringify(tree).includes('application/pdf · 23 B'))
    await nodes(tree, 'Button')[0].props.onClick()
    assert.equal(h.copied[0], '  @reference /skill\n')
    assert.equal(nodes(h.render(content), 'div').some(node => node.props.role === 'status'), true)
    assert.equal(nodes(tree, 'Modal').length, 0)
  }
})

test('render-time envelope projection shows body only; menu opens exact raw modal and navigation', async () => {
  const h = harness(), content = [{ type: 'text', text: raw }]
  let tree = h.render(content)
  assert.equal(tree.props['data-rabi-message'], 'agent')
  assert.equal(h.projections[0][0], '  body @reference /skill')
  let menu = nodes(tree, 'Menu')[0]
  assert.deepEqual(Array.from(menu.props.items, item => item.label), ['查看原始消息内容', '定位到Agent'])
  menu.props.anchor.props.onClick()
  tree = h.render(content)
  assert.equal(nodes(tree, 'Menu')[0].props.open, true)
  nodes(tree, 'Menu')[0].props.onSelect('raw')
  tree = h.render(content)
  const modal = nodes(tree, 'Modal')[0]
  assert.equal(modal.props.open, true)
  assert.equal(nodes(modal, 'pre')[0].children[0], raw)
  modal.props.onClose()
  assert.equal(nodes(h.render(content), 'Modal')[0].props.open, false)
  await nodes(tree, 'Button')[0].props.onClick()
  assert.deepEqual(h.opened, ['exact-id'])
  nodes(tree, 'Menu')[0].props.onSelect('locate')
  await Promise.resolve(); await Promise.resolve()
  assert.equal(h.opened.at(-1), 'exact-id')
  await nodes(tree, 'Button').at(-1).props.onClick()
  assert.equal(h.copied[0], raw)
})

test('malformed/non-leading envelopes and long history text remain verbatim', () => {
  for (const text of ['prefix\n' + raw, raw.replace('类型：Agent', '类型：User'), raw.replace('会话 ID：exact-id', '会话 ID：exact-id\r\n会话 ID：other'), 'long '.repeat(10000)]) {
    const h = harness(), tree = h.render([{ type: 'text', text }])
    assert.equal(tree.props['data-rabi-message'], 'ordinary')
    assert.equal(h.projections[0][0], text)
  }
})

test('navigation rejects external, missing, incomplete and refreshed-away IDs without opening', async () => {
  const h = harness()
  let refreshes = 0
  h.sessions.refresh = async () => { refreshes++ }
  await assert.rejects(h.openRabiSender(h.sessions, { agentAdapter: 'Codex', sessionId: 'exact-id' }, h.t), /暂不支持/)
  assert.equal(refreshes, 0)
  await assert.rejects(h.openRabiSender(h.sessions, { agentAdapter: 'DSH', sessionId: 'exact' }, h.t), /未找到/)
  h.sessions.list.getSnapshot = () => ({ phase: 'pending', ids: ['exact-id'], byId: { 'exact-id': { id: 'exact-id' } } })
  await assert.rejects(h.openRabiSender(h.sessions, { agentAdapter: 'DSH', sessionId: 'exact-id' }, h.t), /尚不可用/)
  h.sessions.list.getSnapshot = () => ({ phase: 'ready', ids: [], byId: { 'exact-id': { id: 'exact-id' } } })
  await assert.rejects(h.openRabiSender(h.sessions, { agentAdapter: 'DSH', sessionId: 'exact-id' }, h.t), /未找到/)
  assert.deepEqual(h.opened, [])
})

test('navigation and copy errors are visible; unmount cancels navigation after refresh', async () => {
  const h = harness(), content = [{ type: 'text', text: raw }]
  h.sessions.refresh = async () => { throw new Error('offline') }
  await nodes(h.render(content), 'Button')[0].props.onClick()
  assert.match(nodes(h.render(content), 'div').find(node => node.props.role === 'alert').children[0], /offline/)
  let release
  h.sessions.refresh = () => new Promise(resolve => { release = resolve })
  const pending = nodes(h.render(content), 'Button')[0].props.onClick()
  h.effects.forEach(dispose => dispose?.())
  release()
  await pending
  assert.deepEqual(h.opened, [])
})

test('locale and public keyed registrations dispose and remount without private registry access', () => {
  const h = harness(), registrations = [], cleanups = []
  let locales = 0
  const ctx = { sessions: h.sessions, effect: fn => cleanups.push(fn()), locale: { register: (namespace, dictionaries) => { assert.equal(namespace, 'rabiroute-agent-messages'); assert.ok(dictionaries.zh.raw); assert.ok(dictionaries.en.raw); locales++; return () => locales-- } }, slots: { inject: (name, fn) => { assert.equal(name, 'conversation.chat.node'); cleanups.push(fn()) }, register: (spec, view) => { const row = { spec, view }; registrations.push(row); return () => registrations.splice(registrations.indexOf(row), 1) } } }
  for (let round = 0; round < 2; round++) {
    h.apply(ctx)
    assert.equal(locales, 1)
    assert.deepEqual(registrations.map(row => row.spec.key), ['user', 'steering'])
    for (const row of registrations) {
      assert.equal(row.spec.priority, -10)
      assert.equal(row.spec.locale, 'rabiroute-agent-messages')
      assert.equal(row.spec.inject().rabiSessions, h.sessions)
    }
    cleanups.splice(0).reverse().forEach(dispose => dispose())
    assert.equal(locales, 0)
    assert.equal(registrations.length, 0)
  }
})
