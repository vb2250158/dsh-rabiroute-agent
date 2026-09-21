import { resolveManagerBase } from './connection.js'

/**
 * Host-side read model for the plan panel.
 *
 * The panel is Rabi's own plan view rendered in a frame; this module only answers the
 * question the browser cannot answer for itself — which plan this DSH session is bound
 * to, and where Rabi publishes it. Binding, plans and presentation all stay Rabi's:
 * nothing here reads a plan body, caches one, or draws one.
 */

/** The Manager endpoints this read model uses; every one is a read-only GET. */
const BINDING_PATH = '/api/codex-hook/sessions/'
const GATEWAYS_PATH = '/api/gateways?summary=1'

/**
 * The bound-plan scan.
 *
 * Rabi exposes no session-to-plan lookup, so the lookup is done where it can be done
 * cheaply: the `current` view holds the plans a session can actually be working on (Rabi's
 * own completion path requires that view too), and a few pages of summaries cover it. The
 * full catalog is never read — it is hundreds of plans and hundreds of kilobytes per page.
 */
const PLAN_PAGE_LIMIT = 200
/** A hard stop so a pathological catalog cannot turn one panel open into an endless scan. */
const MAX_PLAN_PAGES = 8

/** Where Rabi publishes one plan of one route. */
export function rabiPlanUrl(managerBaseUrl, routeId, planId) {
  return managerBaseUrl + '/#/routes/' + encodeURIComponent(routeId) + '/plan/' + encodeURIComponent(planId)
}

/** One page of current plans for a role. */
export function currentPlansPath(roleId, cursor = '') {
  const query = new URLSearchParams({ view: 'current', limit: String(PLAN_PAGE_LIMIT), detail: 'summary' })
  if (cursor) query.set('cursor', cursor)
  return '/api/roles/' + encodeURIComponent(roleId) + '/plans?' + query.toString()
}

/** Whether one plan claims this session, by task binding or secretary binding. */
export function planBoundToSession(plan, sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) return false
  return String(plan?.taskBinding?.sessionId || '').trim() === id
    || String(plan?.secretaryBinding?.sessionId || '').trim() === id
}

/**
 * Pick the Rabi route whose persona is this role.
 * @param gateways - `/api/gateways?summary=1` payload: an array of route summaries.
 * @param roleId - the role id the session is bound to.
 * @returns the route id, or an empty string when no route serves that role.
 */
export function routeIdForRole(gateways, roleId) {
  const wanted = String(roleId || '').trim()
  if (!wanted || !Array.isArray(gateways)) return ''
  const match = gateways.find(entry => String(entry?.agentRoleId || '').trim() === wanted && String(entry?.id || '').trim())
  return match ? String(match.id).trim() : ''
}

async function readJson(fetcher, url, signal) {
  const response = await fetcher(url, { signal, redirect: 'error', headers: { accept: 'application/json' } })
  const text = await response.text()
  if (!response.ok) throw new Error('Rabi Manager ' + url + ' responded HTTP ' + response.status + '.')
  try { return text ? JSON.parse(text) : {} } catch { throw new Error('Rabi Manager ' + url + ' returned invalid JSON.') }
}

/**
 * Collect the plans that claim this session, reading bounded current-plan summary pages until the pages run out.
 * @param fetcher - the fetch implementation.
 * @param base - the Manager origin.
 * @param roleId - the role whose plans are searched.
 * @param sessionId - the session the plans must claim.
 * @param signal - cancels the remaining pages.
 * @returns the matching plan summaries, in catalog order.
 */
export async function findSessionPlans(fetcher, base, roleId, sessionId, signal) {
  const matched = []
  let cursor = ''
  for (let page = 0; page < MAX_PLAN_PAGES; page++) {
    const payload = await readJson(fetcher, base + currentPlansPath(roleId, cursor), signal)
    const items = Array.isArray(payload?.data?.items) ? payload.data.items : []
    for (const plan of items) if (planBoundToSession(plan, sessionId)) matched.push(plan)
    const next = String(payload?.data?.nextCursor || '').trim()
    if (!next) return matched
    if (items.length === 0 || next === cursor) throw new Error('Rabi plan pagination did not advance.')
    cursor = next
  }
  throw new Error('Rabi plan lookup exceeded its page limit; binding is unresolved.')
}

/** The panel state a client renders: available, or the reason it is not. */
export function unavailablePanel(reason, roleId = '', extra = {}) {
  return { available: false, reason, roleId, routeId: '', planId: '', url: '', managerBaseUrl: '', ...extra }
}

/**
 * Resolve all current plans bound to a session, preserving each owning role.
 * Plan bodies remain in Rabi; the directory contains only summaries and addresses.
 * @param config - plugin config carrying `managerBaseUrl` / `hostExecutable` / `requestTimeoutMs`.
 * @param sessionId - the DSH session id, which is also the Rabi binding key.
 * @param signal - cancels every request.
 * @param dependencies - test seams for `fetch`, `hostStatus` and `resolveManagerBase`.
 * @returns the panel state.
 */
export async function readRabiPlanPanel(config, sessionId, signal, dependencies = {}) {
  const id = String(sessionId || '').trim()
  if (!id) return unavailablePanel('no-session')
  const fetcher = dependencies.fetch || globalThis.fetch
  const base = await (dependencies.resolveManagerBase || resolveManagerBase)(config, signal, dependencies)
  const binding = await readJson(fetcher, base + BINDING_PATH + encodeURIComponent(id), signal)
  // The endpoint answers with the binding itself, or null when the session is unbound.
  let roleId = String(binding?.data?.roleId || '').trim()
  let gateways
  const find = dependencies.findSessionPlans || findSessionPlans
  let bound
  if (roleId) {
    bound = (await find(fetcher, base, roleId, id, signal)).map(plan => ({ plan, roleId }))
  } else {
    // A plan's task binding does not require a Hook persona binding. Discover
    // routed roles from Manager and match their plan summaries by exact session ID.
    gateways = await readJson(fetcher, base + GATEWAYS_PATH, signal)
    if (!Array.isArray(gateways)) throw new Error('Rabi route catalog returned invalid data.')
    const roleIds = [...new Set(gateways.map(route => String(route?.agentRoleId || '').trim()).filter(Boolean))]
    const results = await Promise.all(roleIds.map(async candidateRoleId => ({
      roleId: candidateRoleId, plans: await find(fetcher, base, candidateRoleId, id, signal),
    })))
    bound = results.flatMap(result => result.plans.map(plan => ({ plan, roleId: result.roleId })))
    roleId = results.find(result => result.plans.length)?.roleId || ''
  }
  if (bound.length === 0) return unavailablePanel(roleId ? 'no-plan' : 'unbound', roleId)
  gateways ??= await readJson(fetcher, base + GATEWAYS_PATH, signal)
  if (bound.length > 1) {
    const plans = bound.map(({ plan, roleId: owner }) => {
      const planId = String(plan?.id || '').trim()
      if (!planId) throw new Error('Rabi plan summary has no identity.')
      const routeId = routeIdForRole(gateways, owner)
      const accent = plan.presentation?.palette?.accent
      return { roleId: owner, routeId, planId, planTitle: String(plan.title || planId),
        planStatus: String(plan.presentation?.label || plan.status || ''),
        accent: /^#[0-9a-f]{6}$/i.test(accent || '') ? accent : '',
        url: routeId ? rabiPlanUrl(base, routeId, planId) : '' }
    })
    return { available: true, reason: 'multiple-plans', roleId, managerBaseUrl: base,
      planCount: plans.length, plans, url: '' }
  }
  const plan = bound[0].plan
  const planId = String(plan?.id || '').trim()
  if (!planId) return unavailablePanel('no-plan', roleId)
  gateways ??= await readJson(fetcher, base + GATEWAYS_PATH, signal)
  const routeId = routeIdForRole(gateways, roleId)
  if (!routeId) return unavailablePanel('unrouted', roleId, { planId, planTitle: String(plan?.title || '') })
  return {
    available: true,
    reason: 'bound',
    roleId,
    routeId,
    planId,
    planTitle: String(plan?.title || ''),
    planStatus: String(plan?.status || ''),
    managerBaseUrl: base,
    url: rabiPlanUrl(base, routeId, planId),
  }
}

/** The route a browser calls; only the session id travels, and no plan body is proxied. */
export const PLAN_PANEL_PATH = '/rabiroute/plan-panel'

function sendJson(response, statusCode, body) {
  const text = JSON.stringify(body)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/**
 * Build the HTTP handler for the panel route.
 * @param config - plugin config.
 * @param dependencies - test seams passed through to the read model.
 * @returns a `node:http` request handler owning its own response.
 */
export function createPlanPanelHandler(config, dependencies = {}) {
  return async function planPanelHandler(request, response) {
    if (request.method !== 'GET') {
      sendJson(response, 405, { code: -1, message: 'Method not allowed.' })
      return
    }
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
    const sessionId = requestUrl.searchParams.get('sessionId') || ''
    const controller = new AbortController()
    request.on('close', () => controller.abort(new Error('Panel request was cancelled by the client.')))
    try {
      sendJson(response, 200, { code: 0, data: await readRabiPlanPanel(config, sessionId, controller.signal, dependencies) })
    } catch (error) {
      // A panel read never throws at the browser: the reason travels as data so the
      // panel can say why it is empty instead of showing a broken frame.
      const message = error instanceof Error ? error.message : String(error)
      sendJson(response, 200, { code: 0, data: { ...unavailablePanel('unreachable'), message } })
    }
  }
}
