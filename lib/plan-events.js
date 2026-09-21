import { resolveManagerBase } from './connection.js'

export const PLAN_EVENTS_PATH = '/rabiroute/plan-events'

/** Each visible browser owns a cancellable Manager stream; payloads remain server-side. */
export function createPlanEventRelay(config, cache, dependencies = {}) {
  const clients = new Set()
  return {
    async handler(request, response) {
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
      const controller = new AbortController()
      clients.add(controller)
      const close = () => controller.abort()
      response.once('close', close)
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' })
      response.write('retry: 3000\n\n')
      try {
        const base = await (dependencies.resolveManagerBase || resolveManagerBase)(config, controller.signal, dependencies)
        const upstream = await (dependencies.fetch || fetch)(base + '/api/events', { signal: controller.signal, redirect: 'error', headers: { accept: 'text/event-stream' } })
        if (!upstream.ok || !upstream.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Manager event stream unavailable.')
        let buffer = ''
        const decoder = new TextDecoder()
        for await (const chunk of upstream.body) {
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '')
          if (buffer.length > 65536) throw new Error('Manager event frame too large.')
          let end
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const type = /^event: ?(.+)$/m.exec(frame)?.[1]
            const changed = ['ready', 'plan_changed', 'plan_status_catalog_changed'].includes(type)
            if (changed) cache.invalidate()
            if (!response.write(changed ? 'event: changed\ndata: {}\n\n' : ': keepalive\n\n')) throw new Error('Slow event subscriber.')
          }
        }
      } catch {
        // Closing a failed stream delegates reconnect and identity discovery to EventSource.
      } finally {
        controller.abort()
        clients.delete(controller)
        response.removeListener('close', close)
        response.end()
      }
    },
    dispose() { for (const client of clients) client.abort(); clients.clear() },
  }
}
