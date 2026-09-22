import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createPlanResources } from '../src/plan-resources.js'

async function fixture(t, count = 1) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rabi-resources-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const session = { id: 'session-test', header: { cwd: directory } }
  const plans = Array.from({ length: count }, (_, index) => ({ id: 'p' + index, taskBinding: { sessionId: session.id, agentAdapter: 'dsh' }, attachments: [], steps: [{ id: 's', title: 'step', detail: 'original' }] }))
  const cache = { get: () => ({ entries: { [session.id]: { plans: plans.map(plan => ({ roleId: 'r', planId: plan.id })) } }, stale: false, pending: false }) }
  const writes = []
  let uncertain = false
  let beforeRequest
  const request = async (url, init) => {
    await beforeRequest?.()
    const plan = plans.find(plan => url.endsWith('/' + plan.id))
    if (!plan) return { ok: false }
    if (init.method === 'PATCH') {
      writes.push(init)
      if (uncertain) return { ok: false, uncertain: true, statusCode: 503 }
      const patch = JSON.parse(init.body)
      if (patch.attachments) plan.attachments = patch.attachments.map(item => item.contentBase64 ? { ...item, contentBase64: undefined, sha256: createHash('sha256').update(Buffer.from(item.contentBase64, 'base64')).digest('hex') } : plan.attachments.find(old => old.id === item.id))
      if (patch.steps) plan.steps = patch.steps
    }
    return { ok: true, statusCode: 200, body: JSON.stringify({ code: 0, data: plan }), etag: '"revision"' }
  }
  const config = { planResourcesDirectory: directory }
  const attachments = { async readImage() { return { data: Buffer.from('image') } } }
  const create = () => createPlanResources(config, cache, attachments, { request })
  const service = create()
  t.after(() => service.dispose())
  const event = { type: 'user/message', data: { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'a', name: 'capture.png', mediaType: 'image/png', bytes: 5 } }] } }
  const exec = { agent: { session }, callId: 'call-1', signal: new AbortController().signal }
  return { directory, session, plans, writes, service, create, event, exec, setUncertain(value) { uncertain = value }, setBeforeRequest(value) { beforeRequest = value } }
}

test('single bound plan archives a screenshot once and preserves existing attachments', async t => {
  const f = await fixture(t)
  f.plans[0].attachments.push({ id: 'old', sha256: 'old' })
  f.service.capture(f.session, f.event)
  await f.service.flush()
  assert.equal(f.writes.length, 1)
  assert.equal(f.plans[0].attachments.length, 2)
  assert.equal(f.service.status(f.session.id).pending.length, 0)
  f.service.capture(f.session, f.event)
  await f.service.flush()
  assert.equal(f.writes.length, 1)
})

test('multiple plans require explicit attribution and reject foreign plans and steps', async t => {
  const f = await fixture(t, 2)
  f.service.capture(f.session, f.event)
  await f.service.flush()
  assert.equal(f.writes.length, 0)
  const itemIds = f.service.status(f.session.id).pending.map(item => item.id)
  await assert.rejects(f.service.execute({ action: 'select', roleId: 'r', planId: 'foreign', itemIds }, f.exec))
  await assert.rejects(f.service.execute({ action: 'select', roleId: 'r', planId: 'p0', stepId: 'missing', itemIds }, f.exec))
  await f.service.execute({ action: 'select', roleId: 'r', planId: 'p1', stepId: 's', itemIds }, f.exec)
  await f.service.flush()
  assert.equal(f.plans[0].attachments.length, 0)
  assert.equal(f.plans[1].attachments.length, 1)
})

test('pending choices survive restart; plugin messages do not create uploads', async t => {
  const f = await fixture(t, 2)
  f.service.capture(f.session, { ...f.event, data: { ...f.event.data, source: { kind: 'plugin' } } })
  await f.service.flush()
  assert.equal(f.service.status(f.session.id).pending.length, 0)
  f.service.capture(f.session, f.event)
  await f.service.flush()
  await f.service.dispose()
  const restored = f.create()
  t.after(() => restored.dispose())
  await restored.flush()
  assert.equal(restored.status(f.session.id).pending.length, 1)
  assert.equal(f.writes.length, 0)
})

test('uncertain requests are retained and not replayed on the next flush', async t => {
  const f = await fixture(t)
  f.setUncertain(true)
  f.service.capture(f.session, f.event)
  await f.service.flush()
  await f.service.flush()
  assert.equal(f.writes.length, 1)
  assert.equal(f.service.status(f.session.id).pending[0].uncertain, true)
  const saved = JSON.parse(await readFile(path.join(f.directory, 'pending.json'), 'utf8'))
  assert.equal(saved.items[0].transaction.body, f.writes[0].body)
})

test('changed files require a selected step, preserve its text, and reject outside paths', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.directory, 'code.txt'), 'changed')
  const args = { action: 'record_changes', roleId: 'r', planId: 'p0', stepId: 's', resources: [{ path: 'code.txt', change: 'modified', summary: 'Changed by this task' }] }
  await assert.rejects(f.service.execute(args, f.exec), /Select/)
  await f.service.execute({ action: 'select', roleId: 'r', planId: 'p0', stepId: 's' }, f.exec)
  await assert.rejects(f.service.execute({ ...args, resources: [{ ...args.resources[0], path: '../private.txt' }] }, f.exec), /outside/)
  await f.service.execute(args, f.exec)
  await f.service.flush()
  assert.match(f.plans[0].steps[0].detail, /^original/)
  assert.equal(f.plans[0].steps[0].resourceRecords[0].resources[0].path, 'code.txt')
  assert.equal(f.plans[0].steps[0].resourceRecords[0].resources[0].attribution, 'agent-reported')
})

test('successful structured editor results automatically record the selected step', async t => {
  const f = await fixture(t)
  f.service.captureTool({ ...f.exec, name: 'write' }, { isError: false, value: { path: 'demo.txt', before: null, after: 'new' } }, { roleId: 'r', planId: 'p0', stepId: 's' })
  await f.service.flush()
  const resource = f.plans[0].steps[0].resourceRecords[0].resources[0]
  assert.equal(resource.path, 'demo.txt')
  assert.equal(resource.attribution, 'tool-observed')
  assert.equal(resource.change, 'added')
})

test('a stalled Manager does not block queue inspection or session durability', async t => {
  const f = await fixture(t)
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const seen = new Promise(resolve => { started = resolve })
  f.setBeforeRequest(async () => { started(); await gate })
  f.service.capture(f.session, f.event)
  const upload = f.service.flush()
  await seen
  let timer
  try {
    const inspected = await Promise.race([
      f.service.execute({ action: 'list' }, f.exec).then(async value => { await f.service.checkpoint(); return value }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Blocked by Manager')), 500) }),
    ])
    assert.equal(inspected.pending.length, 1)
  } finally { clearTimeout(timer); release(); await upload }
})
