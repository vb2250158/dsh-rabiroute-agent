import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPlanPanelHandler, currentPlansPath, findSessionPlans, PLAN_PANEL_PATH,
  planBoundToSession, rabiPlanUrl, readRabiPlanPanel, routeIdForRole,
} from '../lib/plan-panel.js'

const base = 'http://127.0.0.1:1728'
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const resolveManagerBase = async () => base
const config = { managerBaseUrl: '' }
const session = 'session-1'
const plan = (id, binding = session, title = 'Example plan') => ({ id, title, status: '进行中', taskBinding: { sessionId: binding } })
const routes = [{ id: 'main', agentRoleId: 'Rabi' }, { id: 'XinghaiBuilder-main', agentRoleId: 'XinghaiBuilder' }]

/**
 * A Manager whose binding, current-plan pages and route table are given. `pages` is keyed by
 * the cursor the scan asks with, so a test states where the bound plan sits in the catalog.
 */
const manager = ({ binding = null, pages = [], gateways = [], onCall } = {}) => ({
  resolveManagerBase,
  fetch: async (url, init) => {
    onCall?.(url, init)
    if (url.startsWith(base + '/api/codex-hook/sessions/')) return json({ code: 0, data: binding })
    if (url.includes('/plans?')) {
      const cursor = new URL(url).searchParams.get('cursor') || ''
      const page = pages.find(entry => (entry.cursor || '') === cursor)
      return json({ code: 0, data: page ? { items: page.items, nextCursor: page.nextCursor || '' } : { items: [], nextCursor: '' } })
    }
    if (url.startsWith(base + '/api/gateways')) return json(gateways)
    return json({ code: -1, message: 'unexpected ' + url }, 404)
  },
})

test('a bound plan resolves to its single-plan Rabi address', async () => {
  const result = await readRabiPlanPanel(config, session, new AbortController().signal, manager({
    binding: { sessionId: session, roleId: 'XinghaiBuilder' },
    pages: [{ items: [plan('plan-abc', session, '[PangHu][功能] 冒险三消游玩界面 F 键直接失败')] }],
    gateways: routes,
  }))
  assert.deepEqual(result, {
    available: true, reason: 'bound', roleId: 'XinghaiBuilder', routeId: 'XinghaiBuilder-main',
    planId: 'plan-abc', planTitle: '[PangHu][功能] 冒险三消游玩界面 F 键直接失败', planStatus: '进行中',
    managerBaseUrl: base,
    url: base + '/#/routes/XinghaiBuilder-main/plan/plan-abc',
  })
})

test('the scan reads the binding, then current plans, then the route table', async () => {
  const calls = []
  await readRabiPlanPanel(config, session, new AbortController().signal, manager({
    binding: { roleId: 'XinghaiBuilder' },
    pages: [{ items: [plan('p1')] }],
    gateways: routes,
    onCall: (url, init) => calls.push([url, init.redirect]),
  }))
  assert.deepEqual(calls, [
    [base + '/api/codex-hook/sessions/session-1', 'error'],
    [base + '/api/roles/XinghaiBuilder/plans?view=current&limit=200&detail=summary', 'error'],
    [base + '/api/gateways?summary=1', 'error'],
  ])
})

test('the scan follows cursors, stops at two matches, and never reads the full catalog', async () => {
  const seen = []
  const fetcher = async url => {
    seen.push(url)
    const cursor = new URL(url).searchParams.get('cursor') || ''
    if (cursor === '') return json({ code: 0, data: { items: [plan('other', 'someone-else')], nextCursor: 'c1' } })
    if (cursor === 'c1') return json({ code: 0, data: { items: [plan('p1')], nextCursor: 'c2' } })
    return json({ code: 0, data: { items: [plan('p2'), plan('p3')], nextCursor: 'c3' } })
  }
  const matched = await findSessionPlans(fetcher, base, 'XinghaiBuilder', session, new AbortController().signal)
  assert.deepEqual(matched.map(item => item.id), ['p1', 'p2', 'p3'])
  // c3 exists, but two matches already mean a conflict the caller reports.
  assert.equal(seen.length, 3)
  assert.ok(seen.every(url => url.includes('view=current')), 'never asks for the full catalog')
  assert.ok(seen.every(url => url.includes('detail=summary')), 'never asks for full plan bodies')
})

test('unbound, unplanned, multi-bound and unrouted sessions each fail closed with their own reason', async () => {
  const signal = new AbortController().signal
  const unbound = await readRabiPlanPanel(config, session, signal, manager({ binding: null }))
  assert.equal(unbound.reason, 'unbound'); assert.equal(unbound.url, '')

  const noPlan = await readRabiPlanPanel(config, session, signal, manager({ binding: { roleId: 'Rabi' }, pages: [{ items: [plan('p9', 'other-session')] }] }))
  assert.equal(noPlan.reason, 'no-plan'); assert.equal(noPlan.url, '')

  // Rabi treats several bound plans as a state to fix, so the panel reports them by name
  // instead of choosing one.
  const many = await readRabiPlanPanel(config, session, signal, manager({
    binding: { roleId: 'Rabi' },
    pages: [{ items: [plan('p1', session, 'First'), plan('p2', session, 'Second')] }],
  }))
  assert.equal(many.reason, 'multiple-plans'); assert.equal(many.planCount, 2)
  assert.deepEqual(many.planTitles, ['First', 'Second']); assert.equal(many.url, '')

  const unrouted = await readRabiPlanPanel(config, session, signal, manager({
    binding: { roleId: 'Nobody' }, pages: [{ items: [plan('p1')] }],
  }))
  assert.equal(unrouted.reason, 'unrouted'); assert.equal(unrouted.planId, 'p1'); assert.equal(unrouted.url, '')

  assert.equal((await readRabiPlanPanel(config, '  ', signal, manager())).reason, 'no-session')
})

test('a secretary binding counts as a bound plan, and a Manager failure never becomes one', async () => {
  const bySecretary = { id: 'p-sec', title: 'Secretary plan', secretaryBinding: { sessionId: session } }
  assert.equal(planBoundToSession(bySecretary, session), true)
  assert.equal(planBoundToSession(bySecretary, 'other'), false)
  assert.equal(planBoundToSession({ id: 'x' }, session), false)

  const failing = { resolveManagerBase, fetch: async () => { throw new Error('disconnected') } }
  await assert.rejects(() => readRabiPlanPanel(config, session, new AbortController().signal, failing), /disconnected/)
  // The route answers 200 with the reason: a broken frame is never shown in Rabi's place.
  const response = await call(createPlanPanelHandler(config, failing), '/rabiroute/plan-panel?sessionId=' + session)
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.data.available, false)
  assert.equal(response.body.data.reason, 'unreachable')
  assert.match(response.body.data.message, /disconnected/)
})

test('the route rejects non-GET and returns the panel state it resolved', async () => {
  const handler = createPlanPanelHandler(config, manager({
    binding: { roleId: 'Rabi' }, pages: [{ items: [plan('p1')] }], gateways: routes,
  }))
  assert.equal((await call(handler, PLAN_PANEL_PATH, 'POST')).statusCode, 405)
  const ok = await call(handler, PLAN_PANEL_PATH + '?sessionId=' + session)
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.body.data.url, base + '/#/routes/main/plan/p1')
})

test('addresses are encoded and route matching is exact role equality', () => {
  assert.equal(routeIdForRole([{ id: 'a', agentRoleId: 'Rabi' }], 'rabi'), '')
  assert.equal(routeIdForRole([{ id: '', agentRoleId: 'Rabi' }], 'Rabi'), '')
  assert.equal(routeIdForRole(undefined, 'Rabi'), '')
  assert.equal(routeIdForRole([{ id: 'a space', agentRoleId: 'Rabi' }], 'Rabi'), 'a space')
  assert.equal(rabiPlanUrl(base, 'a space', 'p/1'), base + '/#/routes/a%20space/plan/p%2F1')
  assert.equal(currentPlansPath('role/x', 'cur sor'), '/api/roles/role%2Fx/plans?view=current&limit=200&detail=summary&cursor=cur+sor')
})

/** Run one handler call against a minimal request/response pair. */
function call(handler, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = { url, method, on: () => {} }
    const response = {
      statusCode: 0, headers: {},
      writeHead(code, headers) { this.statusCode = code; this.headers = headers },
      end(text) { resolve({ statusCode: this.statusCode, headers: this.headers, body: JSON.parse(text) }) },
    }
    Promise.resolve(handler(request, response)).catch(reject)
  })
}
