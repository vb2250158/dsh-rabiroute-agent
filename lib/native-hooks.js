import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { managerRequest } from './connection.js'

const RECORD = 'plugin:dsh-rabiroute-agent/hook-'
const SOURCE = { kind: 'dsh-rabiroute-agent', form: 'notice', summary: 'Rabi Agent Hook' }
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const contextMessage = text => createUserMessage({ content: [{ type: 'text', text }], source: SOURCE })

/** DSH owns lifecycle events; Rabi owns the persona automation rules and receipts. */
export function installNativeHooks(ctx, config, dependencies = {}) {
  const request = dependencies.request ?? managerRequest
  // The source launcher and installed peers may load distinct Session classes.
  const append = dependencies.append ?? ((session, type, data) => session.append(type, data, { ignorable: true }))
  const clock = dependencies.clock ?? Date.now
  const sessions = new WeakMap()
  const shutdown = new AbortController()
  const pending = new Set()
  const required = new Map()
  const bindingService = {
    /** Require live Rabi context for one host-owned session; release on unlink or unload. */
    requireBinding(sessionId, roleId) {
      shutdown.signal.throwIfAborted()
      const previous = required.get(sessionId)
      if (previous && previous.roleId !== roleId) throw new Error('Session already requires another Rabi persona')
      const entry = previous ?? { roleId, owners: new Set() }
      const owner = {}
      entry.owners.add(owner)
      required.set(sessionId, entry)
      return () => { entry.owners.delete(owner); if (!entry.owners.size && required.get(sessionId) === entry) required.delete(sessionId) }
    },
  }
  const stateOf = session => {
    let state = sessions.get(session)
    if (!state) { state = { source: 'resume', started: false, final: null, continuedTurn: null }; sessions.set(session, state) }
    return state
  }
  ctx.effect(() => async () => {
    shutdown.abort(new Error('DSH Agent Hook unloaded'))
    required.clear()
    await Promise.allSettled([...pending])
  })
  ctx.on('agent/created', ({ agent, source }) => { stateOf(agent.session).source = source }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message' && !event.data.interrupted) {
      stateOf(session).final = { turn: event.data.turn, text: textOf(event.data.message) }
    }
  }, { global: true })

  const invoke = (agent, point, turn, fields, ownerSignal) => {
    const task = (async () => {
      const requiredRole = required.get(agent.session.id)?.roleId
      const handlerId = randomUUID()
      const started = clock()
      append(agent.session, RECORD + 'invoked', { turn, point, handlerId, dialect: 'dsh' })
      let outcome = 'failed', statusCode = 0, data = {}, uncertain = false, failure
      try {
        const signal = ownerSignal ? AbortSignal.any([ownerSignal, shutdown.signal]) : shutdown.signal
        const result = await request(config, '/api/codex-hook/context', { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentType: 'dsh', sessionId: agent.session.id, eventName: point,
            cwd: ctx.workingDirectory.get(agent.session), turnId: String(turn), ...fields }) }, signal)
        statusCode = result.statusCode
        uncertain = result.uncertain === true
        if (requiredRole && uncertain) throw new Error('Rabi operation outcome is uncertain; read back the original receipt before continuing')
        if (!result.ok) throw new Error(result.error?.message ?? `Agent Hook HTTP ${statusCode}`)
        const body = JSON.parse(result.body)
        if (body.code !== 0 || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new Error('Invalid Rabi Agent Hook response')
        data = body.data
        if (requiredRole && data.binding?.roleId !== requiredRole) throw new Error('Rabi persona binding changed; check the original session before continuing')
        outcome = data.toolDecision?.permissionDecision === 'deny' ? 'blocked'
          : data.followup?.decision === 'block' ? 'continued'
          : data.completionDeliveries?.some(item => item.status === 'failed')
            || [data.planTaskCompletion, data.agentRequestStop, data.projectFileChangeReminder].some(item => item?.status === 'failed') ? 'failed' : 'passed'
        if (requiredRole && outcome === 'failed') throw new Error('Rabi reported a failed lifecycle operation; read its receipt before continuing')
      } catch (error) {
        failure = error
        ctx.logger.warn('DSH Agent Hook %s failed: %s', point, error instanceof Error ? error.message : String(error))
      }
      append(agent.session, RECORD + 'result', { turn, point, handlerId, outcome, statusCode, uncertain,
        durationMs: Math.max(0, clock() - started) })
      if (failure && requiredRole) throw Object.assign(new Error(`Rabi binding ${point} failed: ${failure.message ?? String(failure)}`), { code: 'rabi/binding-context' })
      return data
    })()
    pending.add(task)
    task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  const turnOf = agent => ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.lastTurn
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    const downstream = await next()
    if (downstream.kind !== 'enter' || shutdown.signal.aborted) return downstream
    const state = stateOf(agent.session)
    const contexts = []
    if (!state.started) {
      const data = await invoke(agent, 'SessionStart', turn, { source: state.source }, signal)
      state.started = true
      if (typeof data.additionalContext === 'string' && data.additionalContext.trim()) contexts.push(data.additionalContext)
    }
    const prompt = messages.filter(message => message.source?.kind !== SOURCE.kind).map(textOf).filter(Boolean).join('\n')
    if (prompt) {
      const data = await invoke(agent, 'UserPromptSubmit', turn, { prompt }, signal)
      if (typeof data.additionalContext === 'string' && data.additionalContext.trim()) contexts.push(data.additionalContext)
    }
    return contexts.length ? { ...downstream, messages: [...downstream.messages, contextMessage(contexts.join('\n'))] } : downstream
  }, { global: true })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const turn = exec.agent && turnOf(exec.agent)
    if (turn === undefined || shutdown.signal.aborted) return next()
    const data = await invoke(exec.agent, 'PreToolUse', turn, { toolName: exec.name, toolInput: exec.arguments, toolUseId: exec.callId }, exec.signal)
    if (data.toolDecision?.permissionDecision === 'deny') return { kind: 'deny', reason: data.toolDecision.reason }
    if (typeof data.additionalContext === 'string' && data.additionalContext.trim()) exec.agent.inject(contextMessage(data.additionalContext))
    return next()
  }, { global: true })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const turn = exec.agent && turnOf(exec.agent)
    if (turn !== undefined && !shutdown.signal.aborted) {
      const data = await invoke(exec.agent, 'PostToolUse', turn, { toolName: exec.name, toolInput: exec.arguments,
        toolUseId: exec.callId, toolResponse: result }, exec.signal)
      if (typeof data.additionalContext === 'string' && data.additionalContext.trim()) exec.agent.inject(contextMessage(data.additionalContext))
    }
    return next()
  }, { global: true })
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (shutdown.signal.aborted) return
    const state = stateOf(agent.session)
    const active = state.continuedTurn === turn
    const data = await invoke(agent, 'Stop', turn, { stopHookActive: active,
      lastAssistantMessage: state.final?.turn === turn ? state.final.text : '' }, signal)
    const contexts = []
    if (data.followup?.decision === 'block') contexts.push(data.followup.reason || 'Rabi 自动化要求继续处理本轮任务。')
    if (typeof data.additionalContext === 'string' && data.additionalContext.trim()) contexts.push(data.additionalContext)
    if (contexts.length && !active) {
      state.continuedTurn = turn
      agent.steer(contextMessage(contexts.join('\n')))
    }
  }, { global: true })
  return bindingService
}
