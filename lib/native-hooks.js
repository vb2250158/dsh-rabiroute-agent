import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { managerRequest } from './connection.js'
import { createHookContextCache, hookCacheKey, hookCacheSource } from './hook-context-cache.js'

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
  const statuses = new Map()
  const contextCache = dependencies.contextCache ?? createHookContextCache(config, { clock, warn: (...args) => ctx.logger.warn(...args) })
  const source = hookCacheSource(config)
  const refreshes = new Map()
  const foregroundMs = config.hookContextForegroundMs ?? 1500
  const retryMs = config.hookContextRetryMs ?? 15000
  if (!Number.isInteger(foregroundMs) || foregroundMs < 1 || foregroundMs > 120000
    || !Number.isInteger(retryMs) || retryMs < 1000 || retryMs > 300000) throw new Error('Invalid Hook context refresh timing')
  const allowsCache = entry => config.hookContextCacheEnabled !== false && entry?.owners.size > 0
    && [...entry.owners].every(owner => owner.allowCachedContext)
  const scopeOf = (agent, roleId) => ({ sessionId: agent.session.id, roleId, cwd: String(ctx.workingDirectory.get(agent.session) ?? ''), source })
  const refreshKeyOf = agent => hookCacheKey(scopeOf(agent, required.get(agent.session.id)?.roleId ?? ''))
  const bindingService = {
    supportsContextCache: true,
    /** Latest active Hook or final failure for a required session; removed on unlink or unload. */
    statusOf(sessionId) {
      const status = statuses.get(sessionId)
      const value = status && (['cached', 'offline', 'sync_unconfirmed'].includes(status.last?.state) ? status.last : [...status.active.values()].at(-1) ?? status.last)
      return value ? { ...value } : null
    },
    /** Require the selected role; all owners must opt into cached context. Release with forgetContext on explicit unlink. */
    requireBinding(sessionId, roleId, options = {}) {
      shutdown.signal.throwIfAborted()
      const previous = required.get(sessionId)
      if (previous && previous.roleId !== roleId) throw new Error('Session already requires another Rabi persona')
      const entry = previous ?? { roleId, owners: new Set() }
      const owner = { allowCachedContext: options.allowCachedContext === true, prepareContext: options.prepareContext }
      entry.hadCache ||= owner.allowCachedContext
      entry.owners.add(owner)
      required.set(sessionId, entry)
      return (options = {}) => { entry.owners.delete(owner); if (!entry.owners.size && required.get(sessionId) === entry) {
        required.delete(sessionId); statuses.delete(sessionId)
        for (const [key, refresh] of refreshes) if (refresh.sessionId === sessionId) refreshes.delete(key)
        if (entry.hadCache && options.forgetContext) {
          const removed = contextCache.forget(sessionId, roleId, source); pending.add(removed)
          removed.then(() => pending.delete(removed), () => pending.delete(removed))
        }
      } }
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
    statuses.clear()
    await Promise.allSettled([...pending])
    await contextCache.flush()
  })
  ctx.on('agent/created', ({ agent, source }) => { stateOf(agent.session).source = source }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message' && !event.data.interrupted) {
      stateOf(session).final = { turn: event.data.turn, text: textOf(event.data.message) }
    }
  }, { global: true })

  const invoke = (agent, point, turn, fields, ownerSignal) => {
    const task = (async () => {
      const requirement = required.get(agent.session.id)
      const requiredRole = requirement?.roleId
      const scope = scopeOf(agent, requiredRole ?? '')
      const handlerId = randomUUID()
      const started = clock()
      const timingStarted = performance.now()
      const timings = []
      const status = requiredRole ? statuses.get(agent.session.id) ?? { active: new Map(), last: null } : null
      if (status) {
        statuses.set(agent.session.id, status)
        status.last = null
        status.active.set(handlerId, { point, state: 'running', at: started })
      }
      append(agent.session, RECORD + 'invoked', { turn, point, handlerId, dialect: 'dsh' })
      let outcome = 'failed', statusCode = 0, data = {}, uncertain = false, failure, failureKind = 'hook_failed', offlineEligible = false
      try {
        const signal = ownerSignal ? AbortSignal.any([ownerSignal, shutdown.signal]) : shutdown.signal
        if (requirement && ['SessionStart', 'UserPromptSubmit'].includes(point)) {
          const preparation = performance.now()
          try { for (const owner of requirement.owners) await owner.prepareContext?.(signal) }
          finally { timings.push({ path: ['binding-prepare'], startMs: preparation - timingStarted, durationMs: performance.now() - preparation }) }
          signal.throwIfAborted()
          if (required.get(agent.session.id) !== requirement) throw new Error('Rabi persona binding changed during context preparation')
        }
        const requestOffset = performance.now() - timingStarted
        const result = await request(config, '/api/codex-hook/context', { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentType: 'dsh', sessionId: agent.session.id, eventName: point,
            cwd: ctx.workingDirectory.get(agent.session), turnId: String(turn), ...fields }) }, signal,
        { onTiming: row => timings.push({ ...row, startMs: row.startMs + requestOffset }) })
        statusCode = result.statusCode
        uncertain = result.uncertain === true
        failureKind = result.error?.code ?? result.error?.kind ?? 'hook_failed'
        offlineEligible = ![401, 403].includes(result.statusCode) && (result.uncertain === true || !result.ok
          && (result.statusCode === 0 || result.statusCode === 408 || result.statusCode === 429 || result.statusCode >= 500
          || /Manager read exceeded \d+ ms/u.test(result.error?.message ?? '')))
        if (requiredRole && uncertain) throw new Error('Rabi operation outcome is uncertain; read back the original receipt before continuing. ' + (result.error?.message ?? ''))
        if (!result.ok) throw new Error(result.error?.message ?? `Agent Hook HTTP ${statusCode}`)
        const body = JSON.parse(result.body)
        if (body.code !== 0 || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new Error('Invalid Rabi Agent Hook response')
        data = body.data
        signal.throwIfAborted()
        if (requirement && required.get(agent.session.id) !== requirement) throw new Error('Rabi persona binding changed during context refresh')
        if (scope.cwd !== scopeOf(agent, requiredRole ?? '').cwd) throw new Error('Rabi workspace changed during context refresh')
        if (data.additionalContext !== undefined && typeof data.additionalContext !== 'string') throw new Error('Invalid Rabi Agent Hook context')
        if (requiredRole && data.binding?.roleId !== requiredRole) {
          if (requirement.hadCache) await contextCache.forget(agent.session.id, requiredRole, source)
          throw new Error('Rabi persona binding changed; check the original session before continuing')
        }
        outcome = data.toolDecision?.permissionDecision === 'deny' ? 'blocked'
          : data.followup?.decision === 'block' ? 'continued'
          : data.completionDeliveries?.some(item => item.status === 'failed')
            || [data.planTaskCompletion, data.agentRequestStop, data.projectFileChangeReminder].some(item => item?.status === 'failed') ? 'failed' : 'passed'
        if (requiredRole && outcome === 'failed') throw new Error('Rabi reported a failed lifecycle operation; read its receipt before continuing')
        if (allowsCache(requirement) && required.get(agent.session.id) === requirement && ['SessionStart', 'UserPromptSubmit'].includes(point)) {
          await contextCache.remember(scope, data.additionalContext ?? '', point === 'SessionStart')
          if (point === 'SessionStart') Object.assign(stateOf(agent.session), { started: true, contextCheckedAt: clock(), contextScopeKey: hookCacheKey(scope) })
        }
      } catch (error) {
        offlineEligible ||= error.offlineEligible === true
        uncertain ||= error.uncertain === true
        failureKind = error.code ?? error.kind ?? failureKind
        if (requirement?.hadCache && !offlineEligible && !ownerSignal?.aborted && !shutdown.signal.aborted
          && ['SessionStart', 'UserPromptSubmit'].includes(point)) await contextCache.forget(agent.session.id, requiredRole, source)
        failure = error
        ctx.logger.warn('DSH Agent Hook %s failed: %s', point, error instanceof Error ? error.message : String(error))
      }
      if (status && statuses.get(agent.session.id) === status) {
        status.active.delete(handlerId)
        status.last = failure ? { point, state: 'failed', code: failureKind, uncertain, at: clock() } : null
      }
      append(agent.session, RECORD + 'result', { turn, point, handlerId, outcome, statusCode, uncertain,
        durationMs: Math.max(0, clock() - started), timings, ...(failure ? { failureKind } : {}) })
      if (failure && requiredRole) throw Object.assign(new Error(`Rabi binding ${point} failed: ${failure.message ?? String(failure)}`), {
        code: failureKind === 'host_stopped' ? 'rabi/host-stopped' : 'rabi/binding-context', offlineEligible, uncertain })
      return data
    })()
    pending.add(task)
    task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  const cachedContext = async (agent, point, turn, signal) => {
    signal?.throwIfAborted(); shutdown.signal.throwIfAborted()
    const requirement = required.get(agent.session.id)
    if (!allowsCache(requirement)) throw new Error('Cached Hook context is no longer enabled')
    const scope = scopeOf(agent, requirement.roleId)
    const cached = await contextCache.get(scope)
    signal?.throwIfAborted(); shutdown.signal.throwIfAborted()
    if (required.get(agent.session.id) !== requirement || !allowsCache(requirement)) throw new Error('Rabi persona binding changed during cache read')
    if (scope.cwd !== scopeOf(agent, requirement.roleId).cwd) throw new Error('Rabi workspace changed during cache read')
    stateOf(agent.session).offlineTurn = turn
    const status = statuses.get(agent.session.id) ?? { active: new Map(), last: null }
    status.last = { point, state: cached ? 'cached' : 'offline', at: clock(), ...(cached ? { cachedAt: cached.at } : {}) }
    statuses.set(agent.session.id, status)
    append(agent.session, RECORD + 'cache-used', { turn, point, cacheAvailable: !!cached, ...(cached ? { cachedAt: cached.at, cacheKey: cached.key } : {}) })
    return { cacheUsed: true, additionalContext: cached
      ? `[Rabi 连接状态]\n本轮使用 ${new Date(cached.at).toISOString()} 确认的人格上下文快照，当前实时连接未确认。下面是历史快照，不代表计划或记忆的最新状态。可以继续普通对话；实时读取、工具检查、计划修改和外发必须等待 Rabi 确认，不得声称已同步或已投递。\n\n${cached.text}`
      : '[Rabi 连接状态]\n当前未取得实时人格资料，也没有有效的已确认快照。可以根据本会话已有对话继续普通答复；不要补造人格设定、记忆、计划或最新状态。实时读取、工具检查、计划修改和外发必须等待 Rabi 确认，不得声称已同步或已投递。' }
  }
  const invokeContext = async (agent, point, turn, fields, signal) => {
    if (!allowsCache(required.get(agent.session.id))) return invoke(agent, point, turn, fields, signal)
    const key = refreshKeyOf(agent)
    const existing = refreshes.get(key)
    if (existing?.promise) return cachedContext(agent, point, turn, signal)
    if (existing?.retryAt > clock()) {
      if (!existing.error.offlineEligible) throw existing.error
      return cachedContext(agent, point, turn, signal)
    }
    const refresh = { sessionId: agent.session.id }
    refresh.promise = invoke(agent, point, turn, fields, signal)
    refreshes.set(key, refresh)
    const settled = refresh.promise.then(data => {
      if (refreshes.get(key) === refresh) refreshes.delete(key)
      return { data }
    }, error => {
      if (refreshes.get(key) === refresh) {
        if (signal?.aborted) refreshes.delete(key)
        else { refresh.promise = null; refresh.error = error; refresh.retryAt = clock() + retryMs }
      }
      return { error }
    })
    let timer
    try {
      const result = await Promise.race([settled, new Promise(resolve => { timer = setTimeout(() => resolve({ waiting: true }), foregroundMs) })])
      if (result.data) return result.data
      if (result.error && !result.error.offlineEligible) throw result.error
      return cachedContext(agent, point, turn, signal)
    } finally { clearTimeout(timer) }
  }
  const invokeAfter = async (agent, point, turn, fields, signal, onLateResult) => {
    const allowed = allowsCache(required.get(agent.session.id))
    const refresh = refreshes.get(refreshKeyOf(agent))
    const waiting = allowed && stateOf(agent.session).offlineTurn === turn
      && (refresh?.promise || (refresh?.retryAt > clock() && refresh.error?.offlineEligible))
    if (waiting) {
      append(agent.session, RECORD + 'sync-unconfirmed', { turn, point, dispatched: false })
      const status = statuses.get(agent.session.id)
      if (status) status.last = { point, state: 'sync_unconfirmed', at: clock(), uncertain: false }
      return {}
    }
    const operation = invoke(agent, point, turn, fields, signal)
    let timer
    try {
      if (!allowed) return await operation
      const settled = operation.then(data => ({ data }), error => ({ error }))
      const result = await Promise.race([settled, new Promise(resolve => { timer = setTimeout(() => resolve({ waiting: true }), foregroundMs) })])
      signal?.throwIfAborted(); shutdown.signal.throwIfAborted()
      if (result.error) throw result.error
      if (result.data) return result.data
      append(agent.session, RECORD + 'sync-unconfirmed', { turn, point, dispatched: true, uncertain: true })
      const status = statuses.get(agent.session.id)
      if (status) status.last = { point, state: 'sync_unconfirmed', at: clock(), uncertain: true }
      if (onLateResult) void settled.then(result => {
        if (result.data && !signal?.aborted && !shutdown.signal.aborted && turnOf(agent) === turn && !agent.inbox?.nextTurn?.length) onLateResult(result.data)
      }).catch(error => ctx.logger.warn('DSH late Hook result could not be applied: %s', error.message))
      return {}
    }
    catch (error) {
      signal?.throwIfAborted(); shutdown.signal.throwIfAborted()
      if (!allowed || !error.offlineEligible) throw error
      const status = statuses.get(agent.session.id)
      if (status) status.last = { point, state: 'sync_unconfirmed', at: clock(), uncertain: error.uncertain === true }
      append(agent.session, RECORD + 'sync-unconfirmed', { turn, point, dispatched: true, uncertain: error.uncertain === true })
      return {}
    } finally { clearTimeout(timer) }
  }
  const turnOf = agent => ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.lastTurn
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    const downstream = await next()
    if (downstream.kind !== 'enter' || shutdown.signal.aborted) return downstream
    const state = stateOf(agent.session)
    const contexts = []
    const requirement = required.get(agent.session.id)
    if (state.started && allowsCache(requirement) && (state.contextScopeKey !== hookCacheKey(scopeOf(agent, requirement.roleId))
      || clock() - state.contextCheckedAt > (config.hookContextCacheMaxAgeMs ?? 86400000))) state.started = false
    if (!state.started) {
      const data = await invokeContext(agent, 'SessionStart', turn, { source: state.source }, signal)
      if (!data.cacheUsed) state.started = true
      if (typeof data.additionalContext === 'string' && data.additionalContext.trim()) contexts.push(data.additionalContext)
    }
    const prompt = messages.filter(message => message.source?.kind !== SOURCE.kind).map(textOf).filter(Boolean).join('\n')
    if (prompt && state.offlineTurn !== turn) {
      const data = await invokeContext(agent, 'UserPromptSubmit', turn, { prompt }, signal)
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
      const data = await invokeAfter(exec.agent, 'PostToolUse', turn, { toolName: exec.name, toolInput: exec.arguments,
        toolUseId: exec.callId, toolResponse: result }, exec.signal)
      if (typeof data.additionalContext === 'string' && data.additionalContext.trim()) exec.agent.inject(contextMessage(data.additionalContext))
    }
    return next()
  }, { global: true })
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (shutdown.signal.aborted) return
    const state = stateOf(agent.session)
    const active = state.continuedTurn === turn
    const continueTurn = data => {
      const contexts = []
      if (data.followup?.decision === 'block') contexts.push(data.followup.reason || 'Rabi 自动化要求继续处理本轮任务。')
      if (typeof data.additionalContext === 'string' && data.additionalContext.trim()) contexts.push(data.additionalContext)
      if (contexts.length && state.continuedTurn !== turn) {
        state.continuedTurn = turn
        agent.steer(contextMessage(contexts.join('\n')))
      }
    }
    const data = await invokeAfter(agent, 'Stop', turn, { stopHookActive: active,
      lastAssistantMessage: state.final?.turn === turn ? state.final.text : '' }, signal, continueTurn)
    continueTurn(data)
  }, { global: true })
  return bindingService
}
