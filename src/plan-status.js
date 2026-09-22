import { resolveManagerBase } from './connection.js'

export const PLAN_STATUS_PATH = '/rabiroute/plan-statuses'

/** Shared, bounded summary read. No plan bodies or per-session requests are fetched. */
export async function readPlanStatusIndex(config, signal, dependencies = {}) {
  const fetcher = dependencies.fetch || globalThis.fetch
  const base = await (dependencies.resolveManagerBase || resolveManagerBase)(config, signal, dependencies)
  const read = async path => {
    const response = await fetcher(base + path, { signal, redirect: 'error', headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error('Plan status HTTP ' + response.status)
    const result = await response.json()
    if (result?.code !== undefined && result.code !== 0) throw new Error('Plan status query failed.')
    return result?.data ?? result
  }
  const gateways = await read('/api/gateways?summary=1')
  if (!Array.isArray(gateways)) throw new Error('Invalid route summaries.')
  const roles = [...new Set(gateways.map(route => route?.agentRoleId).filter(id => typeof id === 'string' && id))]
  const index = Object.create(null)
  let remaining = config.planStatusMaxPages ?? 24
  // Sequential pages keep background work from monopolizing Manager workers.
  for (const role of roles) {
    let cursor = ''
    const cursors = new Set()
    do {
      if (--remaining < 0) throw new Error('Plan status page budget exceeded.')
      const query = new URLSearchParams({ limit: '200', detail: 'summary', facets: '0', sort: 'updated' })
      if (cursor) query.set('cursor', cursor)
      const page = await read('/api/roles/' + encodeURIComponent(role) + '/plans?' + query)
      if (!Array.isArray(page?.items)) throw new Error('Invalid plan summaries.')
      for (const plan of page.items) {
        if (typeof plan?.id !== 'string' || typeof plan?.status !== 'string') throw new Error('Invalid plan status.')
        const ids = new Set([plan.taskBinding?.sessionId, plan.secretaryBinding?.sessionId])
        for (const id of ids) {
          if (typeof id !== 'string' || !id.startsWith('session-')) continue
          const presentation = plan.presentation
          const palette = presentation?.palette
          const validPalette = palette && ['accent', 'background', 'foreground'].every(key => /^#[0-9a-f]{6}$/i.test(palette[key]))
          const entry = { status: plan.status, planId: plan.id, roleId: role,
            label: typeof presentation?.label === 'string' ? presentation.label : plan.status,
            ...(validPalette ? { palette: { accent: palette.accent, background: palette.background, foreground: palette.foreground } } : {}) }
          const summary = { planId: plan.id, roleId: role, title: plan.title, status: plan.status,
            label: entry.label, markerStatus: plan.markerStatus, activationStatus: plan.activationStatus,
            currentStep: plan.currentStep, stepCount: plan.stepCount, completedStepCount: plan.completedStepCount,
            updatedAt: plan.updatedAt }
          const plans = [...(index[id]?.plans || [])]
          const existing = plans.findIndex(value => value.planId === plan.id && value.roleId === role)
          if (existing < 0) plans.push(summary)
          else plans[existing] = summary
          index[id] = plans.length === 1 ? { ...entry, plans } : { status: '', conflict: true, plans }
        }
      }
      dependencies.onProgress?.({ ...index })
      cursor = page.nextCursor || ''
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new Error('Invalid plan cursor.')
      cursors.add(cursor)
    } while (cursor)
  }
  return index
}

/** One cache per plugin instance. HTTP reads never await the external Manager. */
export function createPlanStatusCache(config = {}, dependencies = {}) {
  const now = dependencies.now || Date.now
  const read = dependencies.readIndex || readPlanStatusIndex
  const ttl = config.planStatusCacheMs ?? 60000
  const deadline = config.planStatusTimeoutMs ?? 120000
  const lifetime = new AbortController()
  let snapshot = { entries: {}, updatedAt: 0 }
  let nextRefresh = 0
  let pending = null
  let failed = false
  let revision = 0
  function refresh() {
    if (pending || lifetime.signal.aborted || now() < nextRefresh) return
    const startedRevision = revision
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('Plan status refresh timed out.')), deadline)
    const signal = AbortSignal.any([lifetime.signal, timeout.signal])
    pending = Promise.resolve().then(() => read(config, signal, { ...dependencies, onProgress: entries => {
      if (signal.aborted || startedRevision !== revision) return
      // Incomplete pages may add/update bindings, but cannot remove unseen bindings.
      snapshot = { ...snapshot, entries: { ...snapshot.entries, ...entries } }
      failed = true
    } })).then(entries => {
      signal.throwIfAborted()
      if (startedRevision !== revision) return
      snapshot = { entries, updatedAt: now() }
      failed = false
    }).catch(() => {
      // External read failures retain the last complete snapshot, explicitly stale.
      failed = true
    }).finally(() => {
      clearTimeout(timer)
      nextRefresh = startedRevision === revision ? now() + ttl : 0
      pending = null
      if (startedRevision !== revision) refresh()
    })
  }
  return {
    invalidate() {
      revision++
      failed = true
      nextRefresh = 0
    },
    get() {
      refresh()
      return { ...snapshot, stale: failed || now() - snapshot.updatedAt >= ttl,
        pending: pending !== null, retryAfterMs: pending ? 2000 : Math.max(1000, nextRefresh - now()) }
    },
    async dispose() {
      lifetime.abort()
      await pending
    },
  }
}

/** Cache-only same-origin HTTP response; refresh remains owned by the plugin. */
export function createPlanStatusHandler(cache) {
  return (request, response) => {
    const allowed = request.method === 'GET'
    const text = JSON.stringify(allowed ? { code: 0, data: cache.get() } : { code: -1 })
    response.writeHead(allowed ? 200 : 405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(text)
  }
}
