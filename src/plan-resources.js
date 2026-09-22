import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { managerRequest } from './connection.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const keyOf = plan => `${plan.roleId}/${plan.planId}`
const planPath = plan => `/api/roles/${encodeURIComponent(plan.roleId)}/plans/${encodeURIComponent(plan.planId)}`

/** 会话材料的待发送记录；正式附件与步骤记录仍由 Rabi 保存。 */
export function createPlanResources(config, cache, attachments, dependencies = {}) {
  const directory = config.planResourcesDirectory || path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'storages', 'rabiroute-plan-resources')
  const file = path.join(directory, 'pending.json')
  const request = dependencies.request || ((url, init, signal) => managerRequest(config, url, init, signal))
  const items = new Map()
  const selections = new Map()
  let serial = Promise.resolve()
  let persistence = Promise.resolve()
  const inFlight = new Set()
  let closed = false
  let running = null
  let failure = ''
  const ready = (async () => {
    let saved
    try { saved = JSON.parse(await readFile(file, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (saved.version !== 1 || !Array.isArray(saved.items)) throw new Error('Invalid plan resource queue.')
    for (const item of saved.items) {
      if (!item || typeof item.id !== 'string' || typeof item.sessionId !== 'string' || !['attachment', 'changes'].includes(item.kind)) throw new Error('Invalid queued plan resource.')
      items.set(item.id, item)
    }
  })()
  // A broken queue remains visible and is never overwritten with an empty one.
  ready.catch(error => { failure = error.message })
  const save = () => {
    const result = persistence.then(async () => {
      await mkdir(directory, { recursive: true })
      const temporary = `${file}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify({ version: 1, items: [...items.values()] }), { mode: 0o600 })
      await rename(temporary, file)
    })
    persistence = result.catch(error => { failure = error.message })
    return result
  }
  const lock = work => {
    const result = serial.then(() => ready).then(work)
    // The caller receives this operation's failure; later queue operations still run.
    serial = result.catch(() => {})
    return result
  }
  function plans(sessionId) {
    const snapshot = cache.get()
    return { values: snapshot.entries[sessionId]?.plans || [], fresh: !snapshot.stale && !snapshot.pending }
  }
  async function readPlan(target, sessionId, signal) {
    const result = await request(planPath(target), { method: 'GET' }, signal)
    if (!result.ok || result.uncertain) throw new Error('Plan details unavailable; resources remain pending.')
    const envelope = JSON.parse(result.body)
    if (envelope.code !== undefined && envelope.code !== 0) throw new Error('Plan details rejected.')
    const plan = envelope.data ?? envelope
    if (plan.id !== target.planId || ![plan.taskBinding, plan.secretaryBinding].some(binding => binding?.sessionId === sessionId && (binding.agentType === 'dsh' || binding.agentAdapter === 'dsh'))) throw new Error('Plan is not bound to this DSH session.')
    if (!/^"[^"\r\n]+"$/.test(result.etag || '')) throw new Error('Plan read did not return a strong ETag.')
    return { plan, etag: result.etag }
  }
  async function content(item, signal) {
    if (item.ref.bytes > (config.planResourceMaxBytes ?? 10485760)) throw new Error('Attachment exceeds the configured archive size; original remains in DSH.')
    if (item.type === 'image') return Buffer.from((await attachments.readImage(item.ref, signal)).data)
    const chunks = []
    let length = 0
    for await (const chunk of attachments.readFileStream(item.ref, signal)) {
      length += chunk.byteLength
      if (length > (config.planResourceMaxBytes ?? 10485760)) throw new Error('Attachment exceeds the configured archive size.')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  function present(plan, item) {
    if (item.kind === 'attachment') return plan.attachments?.some(value => value.id === item.id && value.sha256 === item.sha256)
    return plan.steps?.find(step => step.id === item.stepId)?.resourceRecords?.some(record => record.id === item.id)
  }
  async function deliver(item, signal) {
    const target = item.target
    const bytes = item.kind === 'attachment' ? await content(item, signal) : undefined
    if (bytes) item.sha256 = hash(bytes)
    const { plan, etag } = await readPlan(target, item.sessionId, signal)
    if (present(plan, item)) { items.delete(item.id); await save(); return }
    // An uncertain write is read back, never silently replayed with a different revision.
    if (item.uncertain) throw new Error('Previous archive write is uncertain; inspect its saved request before retrying.')
    let patch
    if (item.kind === 'attachment') {
      patch = { attachments: [...(plan.attachments || []).map(value => ({ id: value.id })), {
        id: item.id, name: item.ref.name || `image.${item.ref.mediaType?.split('/')[1] || 'bin'}`,
        ...(item.ref.mediaType ? { mimeType: item.ref.mediaType } : {}), contentBase64: bytes.toString('base64'),
      }] }
    } else {
      if (!plan.steps?.some(step => step.id === item.stepId)) throw new Error('Selected plan step no longer exists.')
      const record = { id: item.id, sessionId: item.sessionId, time: item.time, resources: item.resources }
      patch = { steps: plan.steps.map(step => step.id === item.stepId ? { ...step, resourceRecords: [...(step.resourceRecords || []), record] } : step) }
    }
    item.transaction = { key: randomUUID(), etag, body: JSON.stringify(patch) }
    // Persist intent before crossing the process boundary. A crash requires readback.
    item.uncertain = true
    await save()
    const result = await request(planPath(target), { method: 'PATCH', headers: { 'if-match': etag, 'idempotency-key': item.transaction.key }, body: item.transaction.body }, signal)
    if (!result.uncertain && !result.ok) {
      item.uncertain = false
      delete item.transaction
      await save()
      throw new Error(`Plan archive rejected: HTTP ${result.statusCode}.`)
    }
    const verified = await readPlan(target, item.sessionId, signal)
    if (!present(verified.plan, item)) throw new Error('Archive write not confirmed; resource remains pending.')
    items.delete(item.id)
    await save()
  }
  function flush() {
    if (running || closed) return running
    running = (async () => {
      await ready
      await serial
      for (const item of items.values()) {
        if (closed) break
        if (!item.target) {
          const found = plans(item.sessionId)
          if (item.kind !== 'attachment' || !found.fresh || found.values.length !== 1 || item.requiresChoice) continue
          item.target = { roleId: found.values[0].roleId, planId: found.values[0].planId }
          await save()
        }
        inFlight.add(item.id)
        try { await deliver(item, AbortSignal.timeout(config.planResourceTimeoutMs ?? 12000)) }
        catch (error) { item.error = error.message; await save() }
        finally { inFlight.delete(item.id) }
      }
    })().finally(() => { running = null })
    running.catch(error => { failure = error.message })
    return running
  }
  function capture(session, event) {
    if (closed || event.type !== 'user/message' || event.data.source.kind !== 'user') return
    selections.delete(session.id)
    const found = plans(session.id)
    const parts = event.data.content.filter(part => ['image', 'file'].includes(part.type) && part.attachment)
    if (!parts.length || (found.fresh && !found.values.length)) return
    void lock(async () => {
      for (const [index, part] of parts.entries()) {
        const id = 'dsh-' + hash(`${session.id}/${event.data.id}/${index}`).slice(0, 40)
        if (!items.has(id)) items.set(id, { id, kind: 'attachment', sessionId: session.id, messageId: event.data.id, type: part.type, ref: part.attachment,
          requiresChoice: found.values.length > 1, time: new Date().toISOString() })
      }
      await save()
    }).then(flush).catch(error => { failure = error.message })
  }
  function status(sessionId) {
    return { failure, selected: selections.get(sessionId), pending: [...items.values()].filter(item => item.sessionId === sessionId).map(({ id, kind, ref, target, stepId, error, uncertain }) => ({ id, kind, name: ref?.name, target, stepId, error, uncertain })) }
  }
  function captureTool(exec, result, selected) {
    if (result.isError || !selected?.stepId || !['write', 'edit'].includes(exec.name)) return
    const value = result.value
    if (!value || typeof value.path !== 'string' || typeof value.after !== 'string') return
    const session = exec.agent.session
    const relative = path.relative(session.header.cwd, path.resolve(session.header.cwd, value.path))
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return
    const id = 'dsh-' + hash(`${session.id}/${exec.callId}`).slice(0, 40)
    void lock(async () => {
      if (items.has(id)) return
      items.set(id, { id, kind: 'changes', sessionId: session.id,
        target: { roleId: selected.roleId, planId: selected.planId }, stepId: selected.stepId,
        time: new Date().toISOString(), resources: [{ path: relative.replaceAll('\\', '/'),
          change: value.before === null ? 'added' : 'modified', summary: exec.name,
          sha256: hash(value.after), attribution: 'tool-observed',
        }] })
      await save()
    }).then(flush).catch(error => { failure = error.message })
  }
  async function execute(args, exec) {
    const session = exec.agent?.session
    if (!session) throw new Error('A live DSH session is required.')
    await ready
    if (args.action === 'list') { await serial; return status(session.id) }
    const target = { roleId: args.roleId, planId: args.planId }
    if (!target.roleId || !target.planId) throw new Error('Choose an explicit roleId and planId.')
    const { plan } = await readPlan(target, session.id, exec.signal)
    if (args.stepId && !plan.steps?.some(step => step.id === args.stepId)) throw new Error('Step does not belong to the selected plan.')
    return lock(async () => {
      if (args.action === 'select') {
        const selected = (args.itemIds || []).map(id => {
          const item = items.get(id)
          if (!item || item.sessionId !== session.id || item.kind !== 'attachment' || item.uncertain || inFlight.has(id)) throw new Error('Unknown, foreign, busy, or uncertain resource.')
          return item
        })
        for (const item of selected) { item.target = target; item.requiresChoice = false }
        selections.set(session.id, { ...target, stepId: args.stepId })
        await save()
      } else if (args.action === 'record_changes') {
        if (!args.stepId) throw new Error('Changed files require a specific stepId.')
        const selection = selections.get(session.id)
        if (!selection || keyOf(selection) !== keyOf(target) || selection.stepId !== args.stepId) throw new Error('Select this plan and step before recording changes.')
        if (!Array.isArray(args.resources) || !args.resources.length) throw new Error('Provide changed resources.')
        const root = session.header.cwd
        if (!root) throw new Error('The session has no workspace.')
        const resources = []
        for (const resource of args.resources) {
          if (!['added', 'modified', 'deleted'].includes(resource.change) || !resource.summary) throw new Error('Each resource needs change and summary.')
          const absolute = path.resolve(root, resource.path)
          const relative = path.relative(root, absolute)
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Resource is outside the session workspace.')
          // A report records attribution only; filesystem access stays with DSH's permission-aware tools.
          resources.push({ path: relative.replaceAll('\\', '/'), change: resource.change, summary: resource.summary, attribution: 'agent-reported' })
        }
        const id = 'dsh-' + hash(`${session.id}/${exec.callId}`).slice(0, 40)
        if (!items.has(id)) items.set(id, { id, kind: 'changes', sessionId: session.id, target, stepId: args.stepId, resources, time: new Date().toISOString() })
        await save()
      } else throw new Error('Unknown plan resource action.')
      return status(session.id)
    }).then(result => { void flush(); return result })
  }
  return { capture, captureTool, execute, status, flush,
    async checkpoint() {
      try { await ready; await serial; await persistence }
      catch (error) { failure = error.message }
    },
    async dispose() { closed = true; await serial; await running; await persistence },
  }
}
