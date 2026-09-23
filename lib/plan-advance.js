import { managerRequest, resolveManagerBase } from './connection.js'
import { workspaceIdentity } from './workspace-skills.js'

export const PLAN_ADVANCE_PATH = '/rabiroute/plan-advance'

/** Host lifecycle adapter; persona rules and all dispatch decisions stay in Rabi. */
export function createPlanAdvanceHost(config, listSessions, workspaceRead, dependencies = {}) {
  const request = dependencies.request || ((path, init, signal) => managerRequest(config, path, init, signal))
  let disposed = false, streamController, reconnect, dueTimer, startupTimer, running = false
  const pending = new Map()
  const errors = new Map()
  const controllers = new Set()
  const lifetime = new AbortController()
  const wakeups = new Map()
  async function json(path, init = {}, signal) {
    const result = await request(path, init, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal)
    if (!result.ok) throw new Error(result.error?.message || 'Rabi HTTP ' + result.statusCode)
    return JSON.parse(result.body).data
  }
  async function scopes() {
    const sessions = (await listSessions()).filter(item => !item.blank && workspaceIdentity(item.cwd))
    const groups = new Map()
    for (const item of sessions) { const key = workspaceIdentity(item.cwd); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item.sessionId) }
    const result = []
    for (const [workspace, sessionIds] of groups) {
      const { roleIds } = await workspaceRead(new URLSearchParams({ cwd: workspace, action: 'roles' }))
      for (const roleId of roleIds) result.push({ workspace, roleId, sessionIds })
    }
    return result
  }
  const endpoint = (scope, action) => '/api/roles/' + encodeURIComponent(scope.roleId) + '/plan-advance/' + action
  async function operation(scope, action, body = {}, signal) {
    return json(endpoint(scope, action), { method: 'POST', body: JSON.stringify({ ...body, workspace: scope.workspace, sessionIds: scope.sessionIds }) }, signal)
  }
  async function checkScope(scope, trigger, planIds) {
    const settings = await json(endpoint(scope, 'settings') + '?workspace=' + encodeURIComponent(scope.workspace))
    if (!settings.policy.enabled || (trigger === 'startup' ? !settings.policy.startup : trigger === 'due' ? !settings.policy.due : !settings.policy.events)) return
    let cursor = ''
    do {
      if (disposed) return
      const checked = await operation(scope, 'check', { trigger, cursor, ...(planIds?.length ? { planIds } : {}) })
      if (disposed) return
      for (const item of checked.items) if (item.retryAt) {
        const key = scope.roleId + '/' + item.planId
        clearTimeout(wakeups.get(key))
        wakeups.set(key, setTimeout(() => { wakeups.delete(key); enqueue({ trigger, roleId: scope.roleId, planId: item.planId }) }, Math.max(0, item.retryAt - Date.now())))
      }
      const eligible = checked.items.filter(item => item.eligible)
      if (eligible.length) await operation(scope, 'run', { trigger, planIds: eligible.map(item => item.planId), expected: Object.fromEntries(eligible.map(item => [item.planId, item.fingerprint])) })
      cursor = checked.nextCursor
    } while (cursor && !planIds?.length)
  }
  async function drain() {
    if (running || disposed) return
    running = true
    try {
      const batch = [...pending.values()]; pending.clear()
      const available = await scopes()
      for (const change of batch) for (const scope of available) {
        if (change.roleId && change.roleId !== scope.roleId) continue
        if (change.sessionId && !scope.sessionIds.includes(change.sessionId)) continue
        try { await checkScope(scope, change.trigger, change.planId ? [change.planId] : undefined); errors.delete(scope.roleId) }
        catch (error) { errors.set(scope.roleId, error.message) }
      }
    } catch (error) { errors.set('connection', error.message) }
    finally { running = false; if (pending.size && !disposed) schedule() }
  }
  let scheduled
  const schedule = () => { clearTimeout(scheduled); scheduled = setTimeout(() => { void drain() }, config.planAdvanceEventDelayMs ?? 1000) }
  function enqueue(change) { if (disposed) return; pending.set(JSON.stringify([change.trigger, change.roleId, change.planId, change.sessionId]), change); schedule() }
  async function connect() {
    if (disposed) return
    const controller = new AbortController(); streamController = controller
    try {
      const base = await resolveManagerBase(config, controller.signal)
      const response = await fetch(base + '/api/events', { signal: controller.signal, headers: { accept: 'text/event-stream' } })
      if (!response.ok) throw new Error('Rabi event stream unavailable.')
      const decoder = new TextDecoder(); let buffer = ''
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '')
        if (buffer.length > 65536) throw new Error('Event frame too large.')
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          const type = /^event: ?(.+)$/m.exec(frame)?.[1]
          if (type === 'ready') enqueue({ trigger: 'startup' })
          else if (['plan_changed', 'plan_feedback_changed', 'plan_status_catalog_changed'].includes(type)) {
            const data = JSON.parse(frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n'))
            enqueue({ trigger: 'change', roleId: data.roleId, planId: data.planId })
          }
        }
      }
    } catch (error) { if (!disposed) errors.set('events', error.message) }
    finally { controller.abort(); if (!disposed) reconnect = setTimeout(() => { void connect() }, config.planAdvanceReconnectMs ?? 15000) }
  }
  return {
    enqueue,
    start() {
      startupTimer = setTimeout(() => { void connect(); enqueue({ trigger: 'startup' }) }, config.planAdvanceStartupDelayMs ?? 10000)
      dueTimer = setInterval(() => enqueue({ trigger: 'due' }), config.planAdvanceDueCheckMs ?? 60000)
    },
    async handler(request, response) {
      const controller = new AbortController(); controllers.add(controller)
      response.once('close', () => controller.abort())
      const send = (status, data) => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(data)) } }
      try {
        const url = new URL(request.url, 'http://localhost'); const workspace = workspaceIdentity(url.searchParams.get('cwd'))
        const roleId = url.searchParams.get('roleId'); const action = url.searchParams.get('action')
        const scope = (await scopes()).find(item => item.workspace === workspace && item.roleId === roleId)
        if (!scope) throw new Error('Workspace persona binding is unavailable.')
        if (request.method === 'GET' && action === 'settings') {
          const data = await json(endpoint(scope, action) + '?workspace=' + encodeURIComponent(workspace), {}, controller.signal)
          send(200, { code: 0, data: { ...data, runtimeErrors: Object.fromEntries(errors) } }); return
        }
        if (request.method !== 'POST' || !['settings', 'check', 'run'].includes(action)) throw new Error('Unsupported action.')
        let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 1000000) throw new Error('Request too large.') }
        const body = JSON.parse(raw || '{}'); let data
        if (action === 'settings') {
          data = await json(endpoint(scope, action), { method: 'PUT', body: JSON.stringify({ policy: body.policy, revision: body.revision, workspace }) }, controller.signal)
        } else data = await operation(scope, action, { ...body, trigger: 'manual' }, controller.signal)
        send(200, { code: 0, data })
      } catch (error) { send(400, { code: -1, message: error.message }) }
      finally { controllers.delete(controller) }
    },
    dispose() { disposed = true; lifetime.abort(); clearTimeout(startupTimer); clearTimeout(reconnect); clearTimeout(scheduled); clearInterval(dueTimer); streamController?.abort(); for (const controller of controllers) controller.abort(); for (const timer of wakeups.values()) clearTimeout(timer); wakeups.clear(); pending.clear() },
  }
}
