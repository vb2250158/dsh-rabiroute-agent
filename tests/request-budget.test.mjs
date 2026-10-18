import assert from 'node:assert/strict'
import test from 'node:test'
import { managerRequest } from '../lib/connection.js'

const meta = { health: { state: 'degraded', live: true, requiredReady: true }, applicationGenerationId: 'budget-test', managerInstanceId: 'manager-test' }
const response = value => new Response(JSON.stringify(value))

test('a slow business read uses the configured budget instead of a hidden 12-second deadline', async () => {
  let calls = 0
  const result = await managerRequest({ managerBaseUrl: 'http://localhost:12345', requestTimeoutMs: 20000 }, '/api/roles/fixture/memory', {}, undefined, {
    fetch: async (url, { signal }) => {
      if (url.endsWith('/meta')) return response(meta)
      calls++
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 12500)
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
      })
      return response({ code: 0, data: { items: [] } })
    },
  })
  assert.equal(result.ok, true)
  assert.equal(calls, 1)
})

test('the whole-operation deadline still aborts a write once and retains uncertainty', async () => {
  let calls = 0
  const result = await managerRequest({ managerBaseUrl: 'http://localhost:12345', requestTimeoutMs: 1000 }, '/api/codex-hook/context', { method: 'POST', body: '{}' }, undefined, {
    fetch: async (url, { signal }) => {
      if (url.endsWith('/meta')) return response(meta)
      calls++
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.uncertain, true)
  assert.equal(calls, 1)
})
