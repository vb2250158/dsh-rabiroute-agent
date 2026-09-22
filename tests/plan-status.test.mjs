import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlanStatusCache, createPlanStatusHandler, readPlanStatusIndex } from '../src/plan-status.js'
import { createPlanStatusStore } from '../src/client-plan-status-store.js'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const tick = () => new Promise(resolve => setImmediate(resolve))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('200 simultaneous cold reads return immediately while one slow refresh runs', async () => {
  let calls = 0, finish
  const cache = createPlanStatusCache({}, { readIndex: () => { calls++; return new Promise(resolve => { finish = resolve }) } })
  const started = performance.now()
  for (let n = 0; n < 200; n++) assert.equal(cache.get().pending, true)
  assert.ok(performance.now() - started < 100)
  await tick()
  assert.equal(calls, 1)
  finish({ 'session-a': { status: '分析中' } })
  await tick()
  assert.equal(cache.get().entries['session-a'].status, '分析中')
  assert.equal(calls, 1)
  await cache.dispose()
})

test('refresh is atomic, failure backs off and preserves explicitly stale data', async () => {
  let now = 1000, calls = 0
  const cache = createPlanStatusCache({ planStatusCacheMs: 100 }, { now: () => now, readIndex: async () => {
    calls++
    if (calls === 2) throw new Error('offline')
    return calls === 1 ? { 'session-a': { status: '完成' } } : {}
  } })
  cache.get(); await tick()
  now += 101; cache.get(); await tick()
  assert.equal(cache.get().stale, true)
  assert.equal(cache.get().entries['session-a'].status, '完成')
  assert.equal(calls, 2)
  now += 101; cache.get(); await tick()
  assert.deepEqual(cache.get().entries, {})
  await cache.dispose()
})

test('unload aborts external work and prevents another refresh', async () => {
  let signal
  const cache = createPlanStatusCache({}, { readIndex: (_, received) => {
    signal = received
    return new Promise((_, reject) => received.addEventListener('abort', () => reject(received.reason), { once: true }))
  } })
  cache.get(); await tick(); await cache.dispose()
  assert.equal(signal.aborted, true)
  assert.equal(cache.get().pending, false)
})

test('summary pagination covers completed bindings, deduplicates roles and reports conflicts', async () => {
  const urls = []
  const entries = await readPlanStatusIndex({}, new AbortController().signal, {
    resolveManagerBase: async () => 'http://example.test',
    fetch: async url => {
      urls.push(url)
      if (url.includes('gateways')) return Response.json([{ agentRoleId: 'role' }, { agentRoleId: 'role' }])
      assert.ok(url.includes('detail=summary') && url.includes('facets=0'))
      assert.ok(!url.includes('view=current'))
      return Response.json({ code: 0, data: url.includes('cursor=next') ? {
        items: [{ id: 'two', status: '完成', presentation: { label: '配置状态', palette: { accent: '#607d8b', background: '#eaf4f7', foreground: '#52677a' } }, taskBinding: { sessionId: 'session-b' }, secretaryBinding: { sessionId: 'session-a' } }], nextCursor: null,
      } : { items: [{ id: 'one', status: '分析中', taskBinding: { sessionId: 'session-a' }, secretaryBinding: { sessionId: 'session-a' } }], nextCursor: 'next' } })
    },
  })
  assert.equal(urls.length, 3)
  assert.equal(entries['session-b'].status, '完成')
  assert.equal(entries['session-b'].label, '配置状态')
  assert.equal(entries['session-b'].palette.accent, '#607d8b')
  assert.equal(entries['session-a'].conflict, true)
})

test('incomplete pages reject rather than publishing a false missing binding', async () => {
  await assert.rejects(readPlanStatusIndex({ planStatusMaxPages: 1 }, new AbortController().signal, {
    resolveManagerBase: async () => 'http://example.test',
    fetch: async url => Response.json(url.includes('gateways') ? [{ agentRoleId: 'role' }] : { data: { items: [], nextCursor: 'more' } }),
  }), /budget/)
})

test('200 mounted rows coalesce into one fetch and release the shared scheduler', async () => {
  let calls = 0
  const store = createPlanStatusStore({ delay: 1, fetcher: async () => {
    calls++
    return Response.json({ code: 0, data: { entries: { 'session-a': { status: '分析中' } }, retryAfterMs: 60000 } })
  } })
  const cleanups = Array.from({ length: 200 }, () => store.subscribe(() => {}))
  await wait(30)
  assert.equal(calls, 1)
  assert.equal(store.getSnapshot().entries['session-a'].status, '分析中')
  cleanups.forEach(dispose => dispose())
  store.dispose()
})

test('hidden pages do not start badge traffic', async () => {
  const page = new EventTarget(); page.hidden = true
  let calls = 0
  const store = createPlanStatusStore({ document: page, delay: 1, fetcher: async () => {
    calls++; return Response.json({ code: 0, data: { entries: {}, retryAfterMs: 60000 } })
  } })
  store.subscribe(() => {})
  await wait(10); assert.equal(calls, 0)
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange'))
  await wait(20); assert.equal(calls, 1)
  store.dispose()
})

test('HTTP handler responds without awaiting a blocked Manager', async () => {
  let calls = 0
  const handler = createPlanStatusHandler({ get: () => { calls++; return { entries: {}, pending: true } } })
  let status, body
  const response = { writeHead: code => { status = code }, end: text => { body = JSON.parse(text) } }
  handler({ method: 'GET' }, response)
  assert.equal(status, 200); assert.equal(body.data.pending, true)
  handler({ method: 'POST' }, response)
  assert.equal(status, 405); assert.equal(calls, 1)
})

test('packaged badge uses the row identity and labels stale/conflicting snapshots', async () => {
  let entry
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  vm.runInNewContext(bundle, { window: { __ModuleLoader__: { load: value => { entry = value } } }, setTimeout, clearTimeout, AbortController })
  const react = { memo: value => value, createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (_, get) => get() }
  const client = entry.factory(name => name === 'react' ? react : { Tag: 'Tag', Tooltip: 'Tooltip' })
  const rows = [], cleanups = []
  client.apply({
    sessions: {}, effect: fn => { cleanups.push(fn()) },
    locale: { register: () => () => {}, bind: () => key => key },
    sidebarRightTabs: { register: () => () => {} }, sidebarRight: {},
    slots: { entries: () => [], inject: (_, fn) => fn(), register: (spec, view) => { rows.push({ spec, view }); return () => {} } },
  })
  const badge = rows.find(row => row.spec.name === 'sidebar.workspaces.session.badges')
  assert.ok(badge)
  const render = (id, data) => badge.view({ sessionId: id, t: key => key,
    statusStore: { subscribe() {}, getSnapshot: () => data } })
  const palette = { accent: '#0891b2', background: '#ecfeff', foreground: '#0e7490' }
  const data = { entries: { 'session-a': { status: '分析中', palette }, 'session-b': { status: '完成' } }, stale: false }
  const a = render('session-a', data), b = render('session-b', data)
  assert.equal(a.children[0].children[0].children[0], '分析中')
  assert.deepEqual(render('session-a', { ...data, stale: true }).children, a.children)
  assert.match(a.children[0].children[0].props.style.background, /#0891b2/)
  assert.equal(b.children[0].children[0].children[0], '完成')
  assert.equal(render('unbound', data), null)
  assert.match(render('session-b', { ...data, stale: true }).props.label, /stale/)
  assert.equal(render('session-a', { entries: { 'session-a': { conflict: true } } }).children[0].children[0].children[0], 'conflict')
  const title = rows.find(row => row.spec.name === 'sidebar.workspaces.session.title')
  assert.ok(title)
  assert.equal(title.spec.inject().statusStore, badge.spec.inject().statusStore)
  const renderTitle = (sessionId, text, snapshot = data) => title.view({ sessionId, title: text,
    statusStore: { subscribe() {}, getSnapshot: () => snapshot } })
  assert.equal(renderTitle('session-a', '[PangHu][Bug] 月卡购买'), '月卡购买')
  assert.equal(renderTitle('session-b', '[RabiRoute] 长期维护'), '长期维护')
  assert.equal(renderTitle('unbound', '[PangHu][Bug] 月卡购买'), '[PangHu][Bug] 月卡购买')
  assert.equal(renderTitle('session-a', '[PangHu][Bug] 月卡购买', { entries: {} }), '[PangHu][Bug] 月卡购买')
  assert.equal(renderTitle('session-a', '[PangHu][Bug] 月卡购买', { ...data, stale: true }), '月卡购买')
  assert.equal(renderTitle('session-a', '[PangHu] [Bug] [保留] 月卡购买'), '[保留] 月卡购买')
  assert.equal(renderTitle('session-a', '[PangHu][Bug] '), '[PangHu][Bug] ')
  assert.equal(renderTitle('session-a', '正文 [Bug]'), '正文 [Bug]')
  assert.equal(renderTitle('session-a', '[PangHu][Bug] 月卡购买', { entries: { 'session-a': { conflict: true } } }), '月卡购买')
  cleanups.reverse().forEach(dispose => dispose?.())
})


test('cold refresh exposes completed pages while slower pages remain pending', async () => {
  let finish, progress
  const cache = createPlanStatusCache({}, { readIndex: (_config, _signal, dependencies) => {
    progress = dependencies.onProgress
    return new Promise(resolve => { finish = resolve })
  } })
  cache.get(); await tick()
  progress({ 'session-a': { status: '分析中' } })
  assert.equal(cache.get().entries['session-a'].status, '分析中')
  assert.equal(cache.get().pending, true)
  assert.equal(cache.get().stale, true)
  finish({ 'session-a': { status: '完成' }, 'session-b': { status: '执行中' } })
  await tick()
  assert.equal(cache.get().stale, false)
  assert.equal(cache.get().entries['session-b'].status, '执行中')
  await cache.dispose()
})

test('a later page failure retains earlier pages without deleting prior bindings', async () => {
  let now = 1000, calls = 0
  const cache = createPlanStatusCache({ planStatusCacheMs: 100 }, { now: () => now,
    readIndex: async (_config, _signal, { onProgress }) => {
      if (++calls === 1) return { 'session-old': { status: '完成' } }
      onProgress({ 'session-new': { status: '执行中' } })
      throw new Error('later page failed')
    } })
  cache.get(); await tick(); now += 101; cache.get(); await tick()
  assert.equal(cache.get().entries['session-old'].status, '完成')
  assert.equal(cache.get().entries['session-new'].status, '执行中')
  assert.equal(cache.get().stale, true)
  await cache.dispose()
})
