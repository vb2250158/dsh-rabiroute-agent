/** One plugin-lifetime cache. Inactive pages stay dirty until viewed; events never abort a current read. */
export function createWorkspacePlanStore({ fetcher = (...args) => fetch(...args), Stream = globalThis.EventSource, debounceMs = 250 } = {}) {
  const entries = new Map()
  let stream, disposed = false, maxPages = 1, eventDelay = 200
  const keyOf = (cwd, params) => JSON.stringify([cwd, params.query, params.status, params.tag, params.sort, params.view, params.cursor])
  const empty = () => ({ loading: true, data: null, error: '' })
  const publish = entry => { for (const listener of entry.listeners) listener(entry.state) }
  const trim = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= maxPages) break
      if (!entry.listeners.size && !entry.controller) { clearTimeout(entry.timer); entries.delete(key) }
    }
  }
  const schedule = (entry, delay) => {
    if (disposed || !entry.listeners.size || entry.controller) return
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => { void read(entry) }, delay)
  }
  async function read(entry) {
    if (disposed || !entry.listeners.size || entry.controller) return
    const controller = new AbortController()
    entry.controller = controller; entry.dirty = false
    const old = entry.state.data
    if (!old) { entry.state = { ...entry.state, loading: true, error: '' }; publish(entry) }
    try {
      const params = new URLSearchParams({ cwd: entry.cwd, ...entry.params, delta: '1' })
      if (old) {
        params.set('known', JSON.stringify(old.items.map(item => item.revision)))
        params.set('orderRevision', entry.orderRevision)
        params.set('metaRevision', entry.metaRevision)
      }
      const response = await fetcher('/rabiroute/workspace-plans?' + params, { signal: controller.signal, cache: 'no-store' })
      const body = await response.json()
      if (!response.ok || body.code !== 0) throw new Error(body.message || 'HTTP ' + response.status)
      if (controller.signal.aborted) return
      const patch = body.data
      const rows = new Map((old?.items || []).map(item => [item.revision, item]))
      for (const item of patch.items) rows.set(item.revision, item)
      const order = patch.order ?? old?.items.map(item => item.revision)
      if (!order || order.some(id => !rows.has(id))) throw new Error('Incomplete plan delta.')
      const changed = !old || patch.orderRevision !== entry.orderRevision || patch.metaRevision !== entry.metaRevision
      const items = changed ? order.map(id => rows.get(id)) : old.items
      const data = changed ? { ...(patch.meta ?? old), items } : old
      entry.orderRevision = patch.orderRevision; entry.metaRevision = patch.metaRevision
      if (data.cacheMaxPages) maxPages = data.cacheMaxPages
      if (data.eventDelayMs) eventDelay = data.eventDelayMs
      const notify = changed || entry.state.loading || !!entry.state.error
      entry.state = { data, loading: false, error: '' }
      if (notify) publish(entry)
    } catch (error) {
      if (!controller.signal.aborted) { entry.dirty = true; entry.state = { ...entry.state, loading: false, error: error.message }; publish(entry) }
    } finally {
      if (entry.controller === controller) entry.controller = null
      // Failures wait for a new event, an explicit retry, or reopening, not a retry loop.
      if (!entry.state.error && entry.dirty) schedule(entry, eventDelay)
      trim()
    }
  }
  function connect() {
    if (stream || !Stream || disposed) return
    stream = new Stream('/rabiroute/plan-events')
    stream.addEventListener('changed', event => {
      let change
      try { change = JSON.parse(event.data || '{}') } catch { change = {} }
      for (const entry of entries.values()) {
        if (change.roleId && entry.state.data?.roleIds && !entry.state.data.roleIds.includes(change.roleId)) continue
        entry.dirty = true
        schedule(entry, eventDelay)
      }
    })
    stream.addEventListener('error', () => { for (const entry of entries.values()) entry.dirty = true })
  }
  return {
    snapshot(cwd, params) { return entries.get(keyOf(cwd, params))?.state ?? empty() },
    watch(cwd, params, listener) {
      const key = keyOf(cwd, params)
      let entry = entries.get(key)
      if (!entry) entry = { cwd, params: { ...params }, state: empty(), listeners: new Set(), dirty: true }
      entries.delete(key); entries.set(key, entry)
      entry.listeners.add(listener); listener(entry.state); connect()
      if (entry.dirty) schedule(entry, debounceMs)
      trim()
      return () => {
        entry.listeners.delete(listener)
        if (!entry.listeners.size) {
          clearTimeout(entry.timer)
          if (entry.controller) { entry.dirty = true; entry.controller.abort() }
        }
        trim()
      }
    },
    refresh(cwd, params) {
      const entry = entries.get(keyOf(cwd, params))
      if (entry) { entry.dirty = true; schedule(entry, 0) }
    },
    dispose() {
      disposed = true; stream?.close()
      for (const entry of entries.values()) { clearTimeout(entry.timer); entry.controller?.abort(); entry.listeners.clear() }
      entries.clear()
    },
  }
}
