import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const sources = await Promise.all(['message-envelope', 'client-locales', 'client-plan-locales', 'client-styles', 'plan-icon', 'client-plan', 'client-plan-status-store', 'client-plan-status', 'client-speech', 'client-question', 'client'].map(name => readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8')))
const code = sources.map(source => source.replace(/^import [^\r\n]*\r?\n/gmu, '').replace(/^export /gmu, '')).join('\n')
const raw = '[消息源]\r\n类型：Agent｜处理端：DSH\r\n会话：Test sender\r\n会话 ID：exact-id\r\n投递时间：2026-01-01\r\n\r\n[消息内容]\r\n  body @reference /skill\n\n[回传参数]\n{"deliveryId":"test","responsePolicy":"none"}'
const systemRaw = ['[消息源]', '消息源类型：系统', '事件类型：agent_request_reminder', '事件名称：Agent 回复提醒', '事件 ID：ev-1', '消息包发送时间：2026/9/16 22:15:17', '投递 ID：d-1', '', '[消息内容]', 'MARKER_BODY_TEXT'].join('\n')
const planRaw = ['[消息源]', '消息源类型：计划', '计划名称：示例计划', '计划 ID：plan-abc', '消息包发送时间：2026/9/16 22:15:17', '', '[消息内容]', 'MARKER_BODY_TEXT'].join('\n')

function harness() {
  let states = [], cursor = 0
  const effects = [], projections = [], images = [], copied = [], opened = [], panelCalls = []
  let panelResponse = async () => ({ ok: true, json: async () => ({ code: 0, data: { available: false, reason: 'unbound', roleId: '', routeId: '', url: '' } }) })
  const sessions = { refresh: async () => {}, list: { getSnapshot: () => ({ phase: 'ready', ids: ['exact-id'], byId: { 'exact-id': { id: 'exact-id' } } }) }, open: id => opened.push(id) }
  const React = { Fragment: 'Fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: initial => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] }, useRef: initial => { const index = cursor++; return states[index] ?? (states[index] = { current: initial }) }, useCallback: fn => fn, useEffect: fn => { const index = cursor++; if (!(index in states)) { states[index] = true; effects.push(fn()) } } }
  const context = { React, Button: 'Button', Menu: 'Menu', Modal: 'Modal', JsonBlock: 'JsonBlock', projectUserText: (...args) => { projections.push(args); return { type: 'projected', children: [args[0]], props: {} } }, fileSizeText: bytes => `${bytes} B`, writeClipboard: async text => { copied.push(text); return true }, fetch: async (url, init) => { panelCalls.push({ url, init }); return panelResponse(url, init) }, window: { open() {} }, AbortController, setTimeout, clearTimeout }
  vm.createContext(context)
  vm.runInContext(`${code}\nthis.api = { apply, inject, RabiMessageNodeView, rabiContentParts, openRabiSender, rabiClientLocales, RabiPlanBody, RabiPlanLauncher, rabiPlanTabDefinition, rabiPlanLocales, RABI_PLAN_KIND, RABI_PLAN_TAB_ID, RABI_PLAN_PANEL_PATH, RABI_PLAN_ICON_DATA_URI, registerRabiQuestionComposer, RabiQuestionComposer }`, context)
  const t = (key, values = {}) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), context.api.rabiClientLocales.zh[key])
  const planT = (key, values = {}) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), context.api.rabiPlanLocales.zh[key])
  const render = (content, kind = 'user', extras = {}) => { cursor = 0; return context.api.RabiMessageNodeView({ node: { kind, data: { content, time: 0, referenceLabels: ['reference'], skillNames: ['skill'], ...extras } }, t, rabiSessions: sessions, renderMessageImages: args => { images.push(args); return { type: 'image', props: args, children: [] } } }) }
  const renderPlanBody = (sessionId = 'session-1') => { cursor = 0; return context.api.RabiPlanBody({ sessionId, t: planT }) }
  const renderPlanLauncher = (sessionId = 'session-1', openRabiPlanTab = () => {}) => { cursor = 0; return context.api.RabiPlanLauncher({ sessionId, t: planT, openRabiPlanTab }) }
  return { ...context.api, sessions, render, renderPlanBody, renderPlanLauncher, t, planT, effects, projections, images, copied, opened, panelCalls, setPanelResponse: fn => { panelResponse = fn } }
}
function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, type))
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.children, type)]
}
/** Let the panel's fetch-then-setState chain settle before asserting on the next render. */
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }

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

test('a parsed envelope folds by default and toggles its body without a menu', () => {
  for (const [source, kind, label] of [[systemRaw, 'system', '系统 · Agent 回复提醒 · agent_request_reminder'], [planRaw, 'plan', '计划 · 示例计划（plan-abc）']]) {
    const h = harness(), content = [{ type: 'text', text: source }]
    const folded = h.render(content)
    assert.equal(folded.props['data-rabi-message'], kind)
    // Folded: the body is not projected, so nothing model-facing is on screen,
    // and no locate control is offered because neither kind names an openable
    // session. Only the folded header labels plus copy remain.
    assert.equal(h.projections.length, 0)
    assert.deepEqual(Array.from(nodes(folded, 'Menu')[0].props.items, item => item.label), ['查看原始消息内容'])
    const headerButton = nodes(folded, 'header')[0].children[0]
    assert.equal(headerButton.children[0], label)
    assert.equal(headerButton.props['aria-expanded'], false)
    // `nodes` walks children only, and the overflow control rides the Menu's
    // anchor prop, so the ordered buttons here are header, toggle and copy.
    assert.deepEqual(nodes(folded, 'Button').map(button => button.children[0]), [label, '展开内容', '复制消息'])

    headerButton.props.onClick()
    const expanded = h.render(content)
    assert.equal(nodes(expanded, 'header')[0].children[0].props['aria-expanded'], true)
    assert.equal(h.projections.at(-1)[0], 'MARKER_BODY_TEXT')
    assert.deepEqual(nodes(expanded, 'Button').map(button => button.children[0]), [label, '收起内容', '复制消息'])
    // Collapsing again must return to the folded projection, so the toggle is
    // reversible rather than a one-way reveal. `projections` accumulates across
    // renders, so the count is what proves the second fold projected nothing.
    const projected = h.projections.length
    nodes(expanded, 'header')[0].children[0].props.onClick()
    const refolded = h.render(content)
    assert.equal(nodes(refolded, 'header')[0].children[0].props['aria-expanded'], false)
    assert.equal(h.projections.length, projected)
    // The overflow menu still reaches the exact raw text while folded, so the
    // hidden body stays recoverable without expanding.
    assert.equal(nodes(refolded, 'Menu')[0].props.items[0].id, 'raw')
  }
})

test('an unparsed envelope stays expanded rather than folding behind a nameless header', () => {
  for (const text of ['prefix\n' + raw, raw.replace('类型：Agent', '类型：User'), systemRaw.replace('事件名称：Agent 回复提醒', '事件名称：Agent 回复提醒\r\n事件名称：other')]) {
    const h = harness(), tree = h.render([{ type: 'text', text }])
    assert.equal(tree.props['data-rabi-message'], 'ordinary')
    assert.equal(nodes(tree, 'header').length, 0)
    assert.equal(h.projections[0][0], text)
  }
})

test('malformed/non-leading envelopes and long history text remain verbatim', () => {
  for (const text of ['prefix\n' + raw, raw.replace('类型：Agent', '类型：User'), raw.replace('会话 ID：exact-id', '会话 ID：exact-id\r\n会话 ID：other'), 'long '.repeat(10000)]) {
    const h = harness(), tree = h.render([{ type: 'text', text }])
    assert.equal(tree.props['data-rabi-message'], 'ordinary')
    assert.equal(h.projections[0][0], text)
  }
})
test('navigation rejects missing, incomplete and refreshed-away DSH IDs without opening', async () => {
  const h = harness()
  let refreshes = 0
  h.sessions.refresh = async () => { refreshes++ }
  await assert.rejects(h.openRabiSender(h.sessions, { agentAdapter: 'DSH', sessionId: 'exact' }, h.t), /未找到/)
  h.sessions.list.getSnapshot = () => ({ phase: 'pending', ids: ['exact-id'], byId: { 'exact-id': { id: 'exact-id' } } })
  await assert.rejects(h.openRabiSender(h.sessions, { agentAdapter: 'DSH', sessionId: 'exact-id' }, h.t), /尚不可用/)
  h.sessions.list.getSnapshot = () => ({ phase: 'ready', ids: [], byId: { 'exact-id': { id: 'exact-id' } } })
  await assert.rejects(h.openRabiSender(h.sessions, { agentAdapter: 'DSH', sessionId: 'exact-id' }, h.t), /未找到/)
  assert.deepEqual(h.opened, [])
})

test('a non-DSH sender is handed to the Host locate route instead of being refused', async () => {
  const h = harness()
  // A codex row names a session in another window; this client must not open one itself,
  // and must not claim it moved anything the Host did not confirm.
  h.setPanelResponse(async () => ({ ok: true, json: async () => ({ code: 0, data: { ok: true, reason: 'opened', owner: 'codex_desktop' } }) }))
  let refreshes = 0
  h.sessions.refresh = async () => { refreshes++ }
  await h.openRabiSender(h.sessions, { agentAdapter: 'Codex', sessionId: 'task-abc' }, h.t)
  assert.equal(refreshes, 0)
  assert.deepEqual(h.opened, [])
  assert.equal(h.panelCalls.length, 1)
  assert.equal(h.panelCalls[0].url, '/rabiroute/locate-agent')
  assert.equal(h.panelCalls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(h.panelCalls[0].init.body), { agentAdapter: 'Codex', threadId: 'task-abc' })
})

test('a refused locate surfaces Rabi own reason rather than a generic one', async () => {
  const h = harness()
  h.setPanelResponse(async () => ({ ok: true, json: async () => ({ code: 0, data: { ok: false, reason: 'manager-rejected', message: 'Agent task could not be read by exact ID: task-gone' } }) }))
  await assert.rejects(h.openRabiSender(h.sessions, { agentAdapter: 'codex', sessionId: 'task-gone' }, h.t), /Agent task could not be read by exact ID: task-gone/)
  // An unreachable Host is a failure to ask, not a claimed success.
  h.setPanelResponse(async () => ({ ok: false, status: 502, json: async () => ({}) }))
  await assert.rejects(h.openRabiSender(h.sessions, { agentAdapter: 'codex', sessionId: 'task-abc' }, h.t), /HTTP 502/)
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

test('locale, tab type, body and launcher registrations dispose and remount without private registry access', () => {
  const h = harness(), registrations = [], cleanups = [], definitions = [], openedTabs = []
  let locales = 0
  const ctx = {
    sessions: h.sessions,
    effect: fn => cleanups.push(fn()),
    locale: {
      register: (namespace, dictionaries) => {
        if (namespace === 'rabiroute-agent-messages') { assert.ok(dictionaries.zh.raw); assert.ok(dictionaries.en.raw) }
        else if (namespace === 'rabiroute-speech') { assert.ok(dictionaries.zh.play); assert.ok(dictionaries.en.play) }
        else if (namespace === 'rabiroute-question') { assert.ok(dictionaries.zh.branch); assert.ok(dictionaries.en.branch) }
        else if (namespace === 'rabi-plan-status') { assert.ok(dictionaries.zh.stale); assert.ok(dictionaries.en.stale) }
        else { assert.equal(namespace, 'rabiroute-agent-plan'); assert.ok(dictionaries.zh.tab); assert.ok(dictionaries.en.tab) }
        locales++
        return () => locales--
      },
      bind: namespace => namespace === 'rabiroute-question' ? (key => key) : (assert.equal(namespace, 'rabiroute-agent-plan'), h.planT),
    },
    sidebarRight: { openTab: kind => openedTabs.push(kind) },
    sidebarRightTabs: { register: definition => { definitions.push(definition); return () => definitions.splice(definitions.indexOf(definition), 1) } },
    slots: {
      entries: () => [{ options: { locale: 'question', select: () => null, store: { name: 'drafts' } }, inject: () => ({}), component: 'Official' }],
      inject: (name, fn) => { const dispose = fn(); cleanups.push(dispose); return dispose },
      register: (spec, view) => { const row = { spec, view }; registrations.push(row); return () => registrations.splice(registrations.indexOf(row), 1) },
    },
  }
  for (let round = 0; round < 2; round++) {
    h.apply(ctx)
    assert.equal(locales, 5)
    assert.equal(registrations.filter(row => row.spec.name === 'conversation.chat.assistant-actions' && row.spec.id === 'rabiroute-speech').length, 1)
    const messages = registrations.filter(row => row.spec.name === 'conversation.chat.node')
    assert.deepEqual(messages.map(row => row.spec.key), ['user', 'steering'])
    for (const row of messages) {
      assert.equal(row.spec.priority, -10)
      assert.equal(row.spec.locale, 'rabiroute-agent-messages')
      assert.equal(row.spec.inject().rabiSessions, h.sessions)
    }
    // The plan panel is this plugin's own page type; it takes no other type's kind over.
    assert.deepEqual(definitions.map(definition => [definition.id, definition.kind]), [[h.RABI_PLAN_TAB_ID, h.RABI_PLAN_KIND]])
    const body = registrations.find(row => row.spec.name === 'sidebar.right.pane.tab')
    assert.equal(body.spec.key, h.RABI_PLAN_TAB_ID)
    assert.equal(body.spec.locale, 'rabiroute-agent-plan')
    const launcher = registrations.find(row => row.spec.name === 'conversation.session.header.actions')
    assert.equal(launcher.spec.id, 'rabiroute-agent-plan')
    // The launcher receives one callback and nothing else: no store, no observable.
    assert.deepEqual(Object.keys(launcher.spec.inject()), ['openRabiPlanTab'])
    launcher.spec.inject().openRabiPlanTab()
    assert.deepEqual(openedTabs, [h.RABI_PLAN_KIND])
    openedTabs.length = 0
    cleanups.splice(0).reverse().forEach(dispose => dispose())
    assert.equal(locales, 0)
    assert.equal(registrations.length, 0)
    assert.equal(definitions.length, 0)
  }
})

test('plan panel frames Rabi for a bound session and asks the Host for the target', async () => {
  const h = harness()
  const url = 'http://127.0.0.1:1728/#/routes/ExampleBuilder-main/plan/plan-abc'
  h.setPanelResponse(async () => ({ ok: true, json: async () => ({ code: 0, data: { available: true, reason: 'bound', roleId: 'ExampleBuilder', routeId: 'ExampleBuilder-main', planId: 'plan-abc', planTitle: 'Example', url } }) }))
  h.renderPlanBody('session-1')
  assert.equal(h.panelCalls[0].url, '/rabiroute/plan-panel?sessionId=session-1')
  await flush()
  const frame = nodes(h.renderPlanBody('session-1'), 'iframe')[0]
  assert.equal(frame.props.src, url)
  assert.equal(frame.props.title, h.planT('frameTitle'))
})

test('an unbound session, a session without a bound plan and several bound plans each report their own reason', async () => {
  const h = harness()
  h.renderPlanBody('session-2')
  await flush()
  const unbound = h.renderPlanBody('session-2')
  assert.equal(nodes(unbound, 'iframe').length, 0)
  assert.ok(JSON.stringify(unbound).includes(h.planT('planUnbound')))

  const withoutPlan = harness()
  withoutPlan.setPanelResponse(async () => ({ ok: true, json: async () => ({ code: 0, data: { available: false, reason: 'no-plan', roleId: 'Rabi' } }) }))
  withoutPlan.renderPlanBody('session-2')
  await flush()
  assert.ok(JSON.stringify(withoutPlan.renderPlanBody('session-2')).includes(withoutPlan.planT('planNoPlan')))

  // Several bound plans is Rabi's own error state: the panel names them and frames nothing.
  const many = harness()
  many.setPanelResponse(async () => ({ ok: true, json: async () => ({ code: 0, data: { available: false, reason: 'multiple-plans', planCount: 2, planTitles: ['First', 'Second'] } }) }))
  many.renderPlanBody('session-2')
  await flush()
  const text = JSON.stringify(many.renderPlanBody('session-2'))
  assert.equal(nodes(many.renderPlanBody('session-2'), 'iframe').length, 0)
  assert.ok(text.includes('2') && text.includes('First') && text.includes('Second'))

  const other = harness()
  other.setPanelResponse(async () => { throw new Error('offline') })
  other.renderPlanBody('session-2')
  await flush()
  const unreachable = other.renderPlanBody('session-2')
  assert.equal(nodes(unreachable, 'iframe').length, 0)
  assert.ok(JSON.stringify(unreachable).includes('offline'))
  assert.ok(JSON.stringify(unreachable).includes(other.planT('planUnreachableHint')))
})

test('launcher appears for any Rabi-bound session and auto-opens only when a plan exists', async () => {
  const h = harness()
  let opens = 0
  h.setPanelResponse(async () => ({ ok: true, json: async () => ({ code: 0, data: { available: true, reason: 'bound', roleId: 'Rabi', routeId: 'main', planId: 'plan-1', url: 'http://127.0.0.1:1728/#/routes/main/plan/plan-1' } }) }))
  assert.equal(h.renderPlanLauncher('session-3', () => { opens++ }), null)
  await flush()
  const button = h.renderPlanLauncher('session-3', () => { opens++ })
  assert.equal(button.type, 'Button')
  assert.equal(opens, 1)
  h.renderPlanLauncher('session-3', () => { opens++ })
  assert.equal(opens, 1)
  button.props.onClick()
  assert.equal(opens, 2)

  // The entry carries Rabi's own mark, not a text label: an icon-only control still
  // needs an accessible name, and the image itself is decorative.
  assert.equal(button.props.icon.type, 'img')
  assert.match(button.props.icon.props.src, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
  assert.equal(button.props.icon.props.alt, '')
  assert.equal(button.props['aria-label'], h.planT('launcherHint'))
  assert.equal(button.props.title, h.planT('launcherHint'))

  // Bound but no plan recorded yet: the entry stays (that is how the panel gets
  // reached), while auto-opening is withheld so no empty column appears.
  const boundNoPlan = harness()
  boundNoPlan.setPanelResponse(async () => ({ ok: true, json: async () => ({ code: 0, data: { available: false, reason: 'no-plan', roleId: 'Rabi' } }) }))
  boundNoPlan.renderPlanLauncher('session-5', () => { opens++ })
  await flush()
  assert.equal(boundNoPlan.renderPlanLauncher('session-5', () => { opens++ }).type, 'Button')
  assert.equal(opens, 2, 'a bound session without a plan must not auto-open')

  const unbound = harness()
  assert.equal(unbound.renderPlanLauncher('session-4', () => { opens++ }), null)
  await flush()
  assert.equal(unbound.renderPlanLauncher('session-4', () => { opens++ }), null)
  assert.equal(opens, 2)
})

test('question wrapper reuses the official composer and keeps its answer path', () => {
  const h = harness()
  const original = {
    options: { locale: 'question', select: owner => owner.pendingInteraction, store: { name: 'drafts' } },
    inject: () => ({ official: true }),
    component: 'Official',
  }
  const registered = []
  const ctx = {
    effect: fn => fn(),
    locale: { register() {}, bind: ns => key => `${ns}:${key}` },
    slots: {
      entries: () => [original],
      inject: (name, factory) => { if (name === 'conversation.composer') factory() },
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
  }
  h.registerRabiQuestionComposer(ctx)
  assert.equal(registered[0].options.locale, 'question')
  assert.equal(registered[0].options.priority, -10)
  assert.equal(registered[0].options.select, original.options.select)
  assert.equal(registered[0].options.store, original.options.store)
  const tree = registered[0].component({ sessionId: 'session-one', matched: { key: 'question:1' } })
  assert.equal(tree.type, h.RabiQuestionComposer)
  assert.equal(tree.props.Official, 'Official')
  const inner = h.RabiQuestionComposer(tree.props)
  assert.equal(inner.props['data-rabi-question'], true)
  assert.equal(inner.children[0].type, 'Official')
})
