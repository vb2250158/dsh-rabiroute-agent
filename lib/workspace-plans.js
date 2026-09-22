import { workspacePageDelta } from './workspace-plan-delta.js'
import { managerRequest } from './connection.js'
import { workspaceIdentity } from './workspace-skills.js'

export const WORKSPACE_PLANS_PATH = '/rabiroute/workspace-plans'

/** Route discovery never reads plan catalogs; concurrent workspace buttons share one read. */
export function createWorkspacePlans(config, listSessions, dependencies = {}) {
  const request = dependencies.request ?? ((path, init, signal) => managerRequest(config, path, init, signal))
  let discovery, expires = 0
  async function json(path, init, signal) {
    const response = await request(path, init, signal)
    if (!response.ok) throw new Error('Rabi plan query failed: HTTP ' + response.statusCode)
    return JSON.parse(response.body)
  }
  async function routes(signal) {
    if (!discovery || Date.now() >= expires) {
      expires = Date.now() + (config.workspaceSkillCacheMs ?? 30000)
      discovery = json('/api/gateways', {}, undefined).catch(error => { discovery = undefined; throw error })
    }
    const result = await discovery
    signal?.throwIfAborted()
    return result
  }
  return async function read(params, signal) {
    const cwd = workspaceIdentity(params.get('cwd'))
    if (!cwd) throw new Error('An absolute workspace is required.')
    const roles = new Map()
    for (const route of await routes(signal)) {
      if (route.enabled === false || !route.agentRoleId) continue
      if (!(route.agentAdapters ?? []).some(adapter => {
        const state = route.agentStates?.[adapter]
        return workspaceIdentity(state?.monitorThreadCwd || state?.monitorProjectPath) === cwd
      })) continue
      if (!roles.has(route.agentRoleId)) roles.set(route.agentRoleId, route.id)
    }
    if (params.get('action') === 'match') return { matched: roles.size > 0 }
    if (!roles.size) return { items: [], roleIds: [], total: 0, nextCursor: '', facets: { statuses: [], tags: [] } }
    const sessions = (await listSessions(signal)).filter(session => !session.blank && workspaceIdentity(session.cwd) === cwd)
    const byId = new Map(sessions.map(session => [session.sessionId, session]))
    let offsets = {}
    if (params.get('cursor')) {
      offsets = JSON.parse(Buffer.from(params.get('cursor'), 'base64url').toString())
      if (!offsets || Array.isArray(offsets) || Object.values(offsets).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid cursor.')
    }
    const sort = params.get('sort') || 'status'
    const pages = await Promise.all([...roles].map(async ([roleId, routeId]) => {
      const result = await json('/api/roles/' + encodeURIComponent(roleId) + '/plans/query', { method: 'POST', body: JSON.stringify({
        cursor: String(offsets[roleId] || 0), limit: 20, query: params.get('query') || '', sort,
        ...(params.get('view') ? { view: params.get('view') } : {}),
        statuses: params.getAll('status').filter(Boolean), tags: params.getAll('tag').filter(Boolean),
        bindingScope: { agentType: 'dsh', workspace: cwd, sessionIds: [...byId.keys()] },
      }) }, signal)
      if (!Array.isArray(result.data?.items)) throw new Error('Rabi returned an invalid plan page.')
      return { roleId, routeId, ...result.data }
    }))
    const items = pages.flatMap(page => page.items.map(plan => ({ ...plan, roleId: page.roleId, routeId: page.routeId })))
    const rank = plan => sort === 'updated' ? -Date.parse(plan.updatedAt) : sort === 'importance' ? plan.presentation.importance.level : sort === 'urgency' ? plan.presentation.urgency.level : plan.presentation.statusLevel
    items.sort((a, b) => rank(a) - rank(b) || a.roleId.localeCompare(b.roleId))
    const selected = items.slice(0, 20)
    for (const item of selected) offsets[item.roleId] = (offsets[item.roleId] || 0) + 1
    const facets = { statuses: new Map(), tags: new Map() }
    for (const page of pages) for (const key of ['statuses', 'tags']) for (const facet of page.facets[key]) {
      const id = facet.status ?? facet.tag
      const old = facets[key].get(id)
      facets[key].set(id, { ...facet, count: (old?.count || 0) + facet.count })
    }
    return { roleIds: [...roles.keys()], cacheMaxPages: config.workspacePlanCachePages ?? 32, eventDelayMs: config.workspacePlanEventDelayMs ?? 200, items: selected.map(plan => {
      const bindings = [...new Set([plan.taskBinding, plan.secretaryBinding].filter(binding => binding?.agentType === 'dsh' && workspaceIdentity(binding.workspace) === cwd && byId.has(binding.sessionId)).map(binding => binding.sessionId))]
      return { id: plan.id, roleId: plan.roleId, title: plan.title, currentStep: plan.currentStep, presentation: plan.presentation,
        sessions: bindings.map(id => ({ id, title: byId.get(id).projections?.values?.title || id })) }
    }), total: pages.reduce((sum, page) => sum + page.total, 0),
      nextCursor: pages.some(page => (offsets[page.roleId] || 0) < page.total) ? Buffer.from(JSON.stringify(offsets)).toString('base64url') : '',
      facets: { statuses: [...facets.statuses.values()], tags: [...facets.tags.values()] } }
  }
}

/** Same-origin read-only bridge; aborted browsers do not retain plan work. */
export function createWorkspacePlansHandler(read) {
  return async (request, response) => {
    const controller = new AbortController()
    response.on('close', () => controller.abort())
    const send = (status, body) => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)) } }
    if (request.method !== 'GET') return send(405, { code: -1 })
    try {
      const params = new URL(request.url, 'http://localhost').searchParams
      const page = await read(params, controller.signal)
      send(200, { code: 0, data: params.get('delta') === '1' ? workspacePageDelta(page, params) : page })
    }
    catch (error) { send(503, { code: -1, message: error.message }) }
  }
}
