import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createPlanEventRelay } from '../src/plan-events.js'
import { createPlanStatusCache } from '../src/plan-status.js'
import { createPlanStatusStore } from '../src/client-plan-status-store.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('in-flight invalidations coalesce and are never overwritten by refresh completion', async () => {
  const resolvers = []
  const cache = createPlanStatusCache({}, { readIndex: () => new Promise(resolve => resolvers.push(resolve)) })
  cache.get(); await tick()
  for (let i = 0; i < 200; i++) cache.invalidate()
  resolvers[0]({ old: {} }); await tick()
  assert.equal(resolvers.length, 2)
  resolvers[1]({ latest: {} }); await tick()
  assert.deepEqual(cache.get().entries, { latest: {} })
  await cache.dispose()
})

test('one browser event stream shares burst refreshes, preserves colors, and closes on disposal', async () => {
  let stream, calls = 0
  class Stream extends EventTarget { constructor() { super(); stream = this } close() { this.closed = true } }
  const entries = { 'session-a': { status: 'done', palette: { accent: '#123456' } } }
  const store = createPlanStatusStore({ EventSource: Stream, delay: 1, fetcher: async () => {
    calls++; return Response.json({ code: 0, data: { entries, stale: false, pending: false } })
  } })
  const release = Array.from({ length: 200 }, () => store.subscribe(() => {}))
  await wait(20)
  assert.equal(calls, 1)
  for (let i = 0; i < 200; i++) stream.dispatchEvent(new Event('changed'))
  await wait(20)
  assert.equal(calls, 2)
  stream.dispatchEvent(new Event('error'))
  assert.deepEqual(store.getSnapshot().entries, entries)
  release.forEach(fn => fn()); assert.equal(stream.closed, true)
  store.dispose()
})

test('relay filters fragmented SSE, invalidates ready and changes, and cancels upstream', async () => {
  let invalidations = 0, signal
  const relay = createPlanEventRelay({}, { invalidate() { invalidations++ } }, {
    resolveManagerBase: async () => 'http://localhost:1',
    fetch: async (_url, options) => {
      signal = options.signal
      return new Response(new ReadableStream({ start(controller) {
        for (const chunk of ['event: rea', 'dy\ndata: {}\n\n', 'event: unrelated\ndata: {}\n\n', 'event: plan_changed\ndata: {"roleId":"role","planId":"plan","privateBody":"hidden"}\n\n']) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      } }), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const response = Object.assign(new EventEmitter(), { output: '', writeHead() { this.headersSent = true }, write(text) { this.output += text; return true }, end() {} })
  await relay.handler({ method: 'GET' }, response)
  assert.equal(invalidations, 2)
  assert.match(response.output, /"roleId":"role","planId":"plan"/)
  assert.doesNotMatch(response.output, /privateBody|hidden/)
  assert.equal(response.output.match(/event: changed/g).length, 2)
  assert.equal(signal.aborted, true)
  relay.dispose()
})
