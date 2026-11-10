import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createPlanResources } from '../src/plan-resources.js'
import { installPlanResources } from '../src/plan-resources-install.js'

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

test('selected plan and step survive user messages and restart without expiry', async t => {
  const f = await fixture(t)
  await f.service.execute({ action: 'select', roleId: 'r', planId: 'p0', stepId: 's' }, f.exec)
  const archive = JSON.parse(await readFile(path.join(f.directory, 'selections.json'), 'utf8'))
  assert.deepEqual(archive.selections, [{ sessionId: f.session.id, roleId: 'r', planId: 'p0', stepId: 's' }])
  f.service.capture(f.session, { ...f.event, data: { ...f.event.data, content: [] } })
  assert.equal(f.service.status(f.session.id).selected.stepId, 's')
  await f.service.dispose()
  const restored = f.create()
  t.after(() => restored.dispose())
  await restored.whenReady()
  assert.deepEqual(restored.status(f.session.id).selected, { roleId: 'r', planId: 'p0', stepId: 's' })
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

test('uncertain attachment reconciliation does not reread the attachment', async t => {
  const f = await fixture(t)
  f.setUncertain(true)
  f.service.capture(f.session, f.event)
  await f.service.flush()
  await f.service.dispose()
  const restored = createPlanResources({ planResourcesDirectory: f.directory }, { get: () => ({}) }, {
    readImage() { throw new Error('Attachment must not be read during reconciliation') },
  }, { request: async (_url, init) => {
    assert.equal(init.method, 'GET')
    return { ok: true, body: JSON.stringify({ data: f.plans[0] }), etag: '"revision"' }
  } })
  t.after(() => restored.dispose())
  await restored.flush()
  assert.match(restored.status(f.session.id).pending[0].error, /Previous archive write is uncertain/)
  assert.equal(f.writes.length, 1)
})

test('failed retries checkpoint changed errors once and leave unchanged failures on disk', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rabi-resource-retries-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const items = Array.from({ length: 3 }, (_, index) => ({
    id: `pending-${index}`, kind: 'attachment', sessionId: 'session-test',
    target: { roleId: 'r', planId: 'p' }, uncertain: true,
    transaction: { key: `request-${index}`, etag: '"revision"', body: `retained-${index}` },
  }))
  const file = path.join(directory, 'pending.json')
  await writeFile(file, JSON.stringify({ version: 1, items }))
  const stringify = JSON.stringify
  let checkpoints = 0
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    if (value?.version === 1 && Array.isArray(value.items)) checkpoints++
    return stringify(value, ...args)
  })
  const service = createPlanResources({ planResourcesDirectory: directory }, {}, {
    readImage() { throw new Error('Uncertain attachments are readback-only') },
  }, { request: async (_url, init) => {
    assert.equal(init.method, 'GET')
    return { ok: false }
  } })
  t.after(() => service.dispose())
  await service.flush()
  assert.equal(checkpoints, 1)
  const saved = await readFile(file, 'utf8')
  assert.deepEqual(JSON.parse(saved).items, items.map(item => ({
    ...item, error: 'Plan details unavailable; resources remain pending.',
  })))
  await service.flush()
  assert.equal(checkpoints, 1)
  assert.equal(await readFile(file, 'utf8'), saved)
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

test('choosing a plan does not bypass attribution of remaining multi-plan attachments', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rabi-resource-guard-'))
  const listeners = new Map(), cleanup = []
  const ctx = { attachments: {}, tools: { register() {} }, systemPrompt: { context() {} }, on(name, callback) { listeners.set(name, callback) }, effect(callback) { cleanup.push(callback()) } }
  let bound = [{ roleId: 'r', planId: 'a' }, { roleId: 'r', planId: 'b' }]
  const service = installPlanResources(ctx, { planResourcesDirectory: directory }, { get: () => ({ entries: { s: { plans: bound } } }) })
  t.after(async () => { for (const dispose of cleanup) await dispose(); await rm(directory, { recursive: true, force: true }) })
  const state = { selected: { planId: 'a', roleId: 'r', stepId: 'step' }, pending: [{ id: 'image' }] }
  service.status = () => state
  const exec = { name: 'read', agent: { session: { id: 's' } } }
  assert.equal((await listeners.get('tools/pre-execute')(exec, () => 'allowed')).kind, 'deny')
  state.pending[0].target = { planId: 'b', roleId: 'r' }
  assert.equal(await listeners.get('tools/pre-execute')(exec, () => 'allowed'), 'allowed')
  bound = [{ roleId: 'r', planId: 'b' }, { roleId: 'r', planId: 'c' }]
  assert.equal((await listeners.get('tools/pre-execute')(exec, () => 'allowed')).kind, 'deny')
})

async function queuedFixture(t, items, dependencies, attachments = {}, config = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rabi-resource-cooldown-'))
  const file = path.join(directory, 'pending.json')
  await writeFile(file, JSON.stringify({ version: 1, items }))
  const service = createPlanResources({ planResourcesDirectory: directory, ...config }, {}, attachments, dependencies)
  t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { service, file }
}

function queuedAttachment(id, extra = {}) {
  return { id, kind: 'attachment', sessionId: 'session-test', type: 'image',
    target: { roleId: 'r', planId: 'p' },
    ref: { attachmentId: id, name: `${id}.png`, bytes: 5 }, ...extra }
}

const imageDigest = createHash('sha256').update('image').digest('hex')
const boundPlan = (extra = {}) => ({ id: 'p', taskBinding: { sessionId: 'session-test', agentAdapter: 'dsh' }, attachments: [], steps: [{ id: 's' }], ...extra })

test('background plan read failures share one retry interval across 1000 resources and isolate roles', async t => {
  for (const failure of [404, 500, 'transport']) {
    await t.test(String(failure), async t => {
      let now = 1000, failedReads = 0, contentReads = 0
      const transaction = { key: 'original-key', etag: '"original"', body: 'original-body' }
      const items = Array.from({ length: 1000 }, (_, index) => queuedAttachment(`failed-${index}`, index === 0 ? { uncertain: true, transaction } : {}))
      items.splice(500, 0, queuedAttachment('healthy', { target: { roleId: 'healthy-role', planId: 'p' } }))
      const f = await queuedFixture(t, items, { now: () => now, request: async (url, init) => {
        assert.equal(init.method, 'GET')
        if (url.includes('/roles/r/')) {
          failedReads++
          if (failure === 'transport') throw new Error('Transport unavailable')
          return { ok: false, statusCode: failure }
        }
        return { ok: true, etag: '"healthy"', body: JSON.stringify({ data: boundPlan({ attachments: [{ id: 'healthy', sha256: imageDigest }] }) }) }
      } }, { async readImage() { contentReads++; return { data: Buffer.from('image') } } }, { planResourceRetryMs: 100 })
      await f.service.flush()
      assert.equal(failedReads, 1)
      assert.equal(contentReads, 1)
      assert.equal(f.service.status('session-test').pending.length, 1000)
      const checkpoint = await readFile(f.file, 'utf8')
      const saved = JSON.parse(checkpoint).items
      assert.deepEqual(saved[0].transaction, transaction)
      assert.equal(saved[0].uncertain, true)
      assert.deepEqual(saved.map(item => item.id), items.filter(item => item.id !== 'healthy').map(item => item.id))
      now = 1099
      await f.service.flush()
      assert.equal(failedReads, 1)
      assert.equal(await readFile(f.file, 'utf8'), checkpoint)
      now = 1100
      await f.service.flush()
      assert.equal(failedReads, 2)
      assert.equal(contentReads, 1)
      assert.equal(await readFile(f.file, 'utf8'), checkpoint)
    })
  }
})

test('expired read failures recover with fresh plan revisions for every write', async t => {
  let now = 0, available = false, reads = 0, revision = 0
  const plan = boundPlan()
  const writes = []
  const f = await queuedFixture(t, [queuedAttachment('one'), queuedAttachment('two')], { now: () => now, request: async (_url, init) => {
    if (init.method === 'GET') {
      reads++
      if (!available) return { ok: false, statusCode: 404 }
      return { ok: true, etag: `"revision-${revision}"`, body: JSON.stringify({ data: plan }) }
    }
    assert.equal(init.headers['if-match'], `"revision-${revision}"`)
    writes.push(init)
    plan.attachments = JSON.parse(init.body).attachments.map(item => item.contentBase64 ? { id: item.id, sha256: imageDigest } : plan.attachments.find(old => old.id === item.id))
    revision++
    return { ok: true }
  } }, { async readImage() { return { data: Buffer.from('image') } } }, { planResourceRetryMs: 100 })
  await f.service.flush()
  available = true
  now = 99
  await f.service.flush()
  assert.equal(reads, 1)
  now = 100
  await f.service.flush()
  assert.equal(reads, 5)
  assert.equal(writes.length, 2)
  assert.equal(new Set(writes.map(write => write.headers['idempotency-key'])).size, 2)
  assert.deepEqual(plan.attachments.map(item => item.id), ['one', 'two'])
  assert.equal(f.service.status('session-test').pending.length, 0)
})

test('manual selection immediately rechecks a failed target and releases its background retry', async t => {
  let available = false, reads = 0
  const plan = boundPlan({ attachments: [{ id: 'existing', sha256: imageDigest }] })
  const f = await queuedFixture(t, [queuedAttachment('existing')], { now: () => 0, request: async (_url, init) => {
    assert.equal(init.method, 'GET')
    reads++
    return available ? { ok: true, etag: '"revision"', body: JSON.stringify({ data: plan }) } : { ok: false, statusCode: 404 }
  } }, { async readImage() { return { data: Buffer.from('image') } } })
  await f.service.flush()
  available = true
  await f.service.execute({ action: 'select', roleId: 'r', planId: 'p', stepId: 's' }, { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal })
  await f.service.flush()
  assert.equal(reads, 3)
  assert.equal(f.service.status('session-test').pending.length, 0)
})

test('session validation and attachment failures do not cool down a healthy target', async t => {
  let reads = 0, contentReads = 0
  const plan = boundPlan({ attachments: [{ id: 'valid', sha256: imageDigest }] })
  const f = await queuedFixture(t, [queuedAttachment('foreign', { sessionId: 'foreign-session' }), queuedAttachment('broken-content'), queuedAttachment('valid')], { request: async (_url, init) => {
    assert.equal(init.method, 'GET')
    reads++
    return { ok: true, etag: '"revision"', body: JSON.stringify({ data: plan }) }
  } }, { async readImage(ref) {
    contentReads++
    if (ref.attachmentId === 'broken-content') throw new Error('Attachment unavailable')
    return { data: Buffer.from('image') }
  } })
  await f.service.flush()
  assert.equal(reads, 3)
  assert.equal(contentReads, 2)
  assert.match(f.service.status('foreign-session').pending[0].error, /not bound/)
  assert.match(f.service.status('session-test').pending[0].error, /Attachment unavailable/)
  assert.equal(f.service.status('session-test').pending.length, 1)
})
test('an older failed background read cannot overwrite a newer successful manual read', async t => {
  let release, started, reads = 0
  const gate = new Promise(resolve => { release = resolve })
  const seen = new Promise(resolve => { started = resolve })
  const plan = boundPlan({ attachments: [{ id: 'existing', sha256: imageDigest }] })
  const f = await queuedFixture(t, [queuedAttachment('existing')], { now: () => 0, request: async (_url, init) => {
    assert.equal(init.method, 'GET')
    reads++
    if (reads === 1) {
      started()
      await gate
      return { ok: false, statusCode: 404 }
    }
    return { ok: true, etag: '"revision"', body: JSON.stringify({ data: plan }) }
  } }, { async readImage() { return { data: Buffer.from('image') } } })
  const background = f.service.flush()
  await seen
  try {
    await f.service.execute({ action: 'select', roleId: 'r', planId: 'p', stepId: 's' }, { agent: { session: { id: 'session-test' } }, signal: new AbortController().signal })
  } finally { release(); await background }
  await f.service.flush()
  assert.equal(reads, 3)
  assert.equal(f.service.status('session-test').pending.length, 0)
})