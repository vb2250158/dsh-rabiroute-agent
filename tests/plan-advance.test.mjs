import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlanAdvanceHost } from '../src/plan-advance.js'

const workspace = 'C:\\example\\project'
const result = data => ({ ok: true, body: JSON.stringify({ code: 0, data }) })

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('plan advancement did not settle')
}

test('event checks a scoped plan and dispatches only its checked fingerprint', async () => {
  const calls = []
  const host = createPlanAdvanceHost({ planAdvanceEventDelayMs: 1 },
    async () => [{ sessionId: 'session-one', cwd: workspace, blank: false }],
    async () => ({ roleIds: ['role-one'] }),
    { request: async (path, init) => {
      calls.push({ path, body: init.body && JSON.parse(init.body) })
      if (path.includes('/settings')) return result({ policy: { enabled: true, events: true } })
      if (path.includes('/check')) return result({ items: [{ planId: 'plan-one', fingerprint: 'fingerprint-one', eligible: true }], nextCursor: '' })
      return result({ items: [{ planId: 'plan-one', state: 'accepted' }] })
    } })
  try {
    host.enqueue({ trigger: 'change', roleId: 'role-one', planId: 'plan-one' })
    await waitUntil(() => calls.some(call => call.path.includes('/run')))
    const checked = calls.find(call => call.path.includes('/check'))
    const dispatched = calls.find(call => call.path.includes('/run'))
    assert.deepEqual(checked.body.planIds, ['plan-one'])
    assert.deepEqual(dispatched.body.expected, { 'plan-one': 'fingerprint-one' })
    assert.deepEqual(dispatched.body.sessionIds, ['session-one'])
  } finally { host.dispose() }
})

test('automatic advancement is disabled by default without scanning plans', async () => {
  const calls = []
  const host = createPlanAdvanceHost({ planAdvanceEventDelayMs: 1 },
    async () => [{ sessionId: 'session-one', cwd: workspace, blank: false }],
    async () => ({ roleIds: ['role-one'] }),
    { request: async path => { calls.push(path); return result({ policy: { enabled: false, events: true } }) } })
  try {
    host.enqueue({ trigger: 'change', roleId: 'role-one', planId: 'plan-one' })
    await waitUntil(() => calls.length > 0)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls.length, 1)
    assert.match(calls[0], /\/settings/)
  } finally { host.dispose() }
})
