/** A single browser subscription shares requests across every mounted session badge. */
export function createPlanStatusStore({ fetcher = globalThis.fetch, document: page = globalThis.document, delay = 100 } = {}) {
  let snapshot = { entries: {}, stale: false }
  const listeners = new Set()
  let timer
  let pending
  let disposed = false
  function emit() {
    for (const listener of listeners) {
      try { listener() } catch { console.warn('Rabi plan-status subscriber failed.') }
    }
  }
  function schedule(ms) {
    clearTimeout(timer)
    if (!disposed && listeners.size && !page?.hidden) timer = setTimeout(refresh, ms)
  }
  async function refresh() {
    if (disposed || pending || !listeners.size || page?.hidden) return
    const controller = new AbortController()
    pending = controller
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 5000)
    let retry = 60000
    try {
      const response = await fetcher('/rabiroute/plan-statuses', { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error('Plan status request failed.')
      const result = await response.json()
      if (result.code !== 0 || !result.data?.entries || typeof result.data.entries !== 'object') throw new Error('Invalid plan statuses.')
      if (disposed || controller.signal.aborted) return
      const data = result.data
      retry = Math.max(1000, Math.min(60000, Number(data.retryAfterMs) || 60000))
      snapshot = { entries: data.entries, stale: !!data.stale }
      emit()
    } catch {
      // Failed/aborted HTTP reads never erase known bindings or reject into React.
      if (!disposed) { snapshot = { ...snapshot, stale: true }; emit() }
    } finally {
      clearTimeout(timeout)
      pending = undefined
      schedule(controller.signal.aborted && !timedOut ? delay : retry)
    }
  }
  function visibility() {
    clearTimeout(timer)
    if (page?.hidden) pending?.abort()
    else schedule(delay)
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      if (listeners.size === 1) { page?.addEventListener('visibilitychange', visibility); schedule(delay) }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { clearTimeout(timer); pending?.abort(); page?.removeEventListener('visibilitychange', visibility) }
      }
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      listeners.clear()
      page?.removeEventListener('visibilitychange', visibility)
      pending?.abort()
    },
  }
}
