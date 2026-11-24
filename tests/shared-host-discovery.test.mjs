import assert from 'node:assert/strict'
import test from 'node:test'
import { createHostDiscovery } from '../src/host-control.js'

test('concurrent callers share a probe and cancellation belongs to each waiter', async () => {
  const probes = []
  const config = {}
  const read = createHostDiscovery(async (_, signal) => {
    const deferred = Promise.withResolvers()
    probes.push({ signal, ...deferred })
    return deferred.promise
  })
  const first = new AbortController()
  const a = read(config, first.signal)
  const b = read(config)
  await Promise.resolve()
  first.abort()
  await assert.rejects(a, { name: 'AbortError' })
  assert.equal(probes.length, 1)
  assert.equal(probes[0].signal.aborted, false)
  probes[0].resolve({ state: 'ready' })
  assert.deepEqual(await b, { state: 'ready' })
  const last = new AbortController()
  const c = read(config, last.signal)
  await Promise.resolve()
  last.abort()
  await assert.rejects(c, { name: 'AbortError' })
  assert.equal(probes[1].signal.aborted, true)
  probes[1].reject(new Error('cancelled'))
})

test('failed discovery backs off only for that configuration, then observes recovery', async () => {
  let time = 0, calls = 0
  const config = { hostDiscoveryRetryMs: 200 }
  const offline = Object.assign(new Error('offline'), { kind: 'host-status-unavailable' })
  const read = createHostDiscovery(async () => {
    if (++calls === 1) throw offline
    return { state: 'ready' }
  }, () => time)
  await assert.rejects(read(config), offline)
  time = 199
  await assert.rejects(read(config), offline)
  assert.equal(calls, 1)
  await read({})
  time = 200
  await read(config)
  await read(config)
  assert.equal(calls, 4)
})
