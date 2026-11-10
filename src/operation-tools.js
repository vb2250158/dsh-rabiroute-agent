/** Adapt the shared Rabi operation tools to DSH without duplicating their schemas or sessions. */
import { createOperationSdk, createOperationTools, OPERATION_TOOL_DEFINITIONS } from '../lib/operation-sdk.js'

/** Names are projected from the shared catalog, never a separately maintained list. */
export const CANONICAL_RABI_TOOL_NAMES = Object.freeze(OPERATION_TOOL_DEFINITIONS.map(definition => definition.name))

/** Keep optional wire fields absent while rejecting values that DSH cannot log as JSON. */
function jsonResult(value) {
  return JSON.parse(JSON.stringify(value, function (_key, item) {
    if (typeof item === 'number' && !Number.isFinite(item) || ['bigint', 'function', 'symbol'].includes(typeof item)
      || item === undefined && Array.isArray(this)) throw new TypeError('Rabi returned a value that cannot be recorded as JSON.')
    return item
  }))
}

function failure(error, args, readOnly, aborted = false) {
  const receipt = error?.receipt
  return jsonResult({
    ok: false,
    ...(aborted ? { aborted: true } : {}),
    uncertain: typeof receipt?.uncertain === 'boolean' ? receipt.uncertain : aborted && !readOnly,
    ...(typeof args?.requestId === 'string' || typeof args?.idempotencyKey === 'string'
      ? { requestId: args.requestId ?? args.idempotencyKey } : {}),
    ...(typeof args?.idempotencyKey === 'string' ? { idempotencyKey: args.idempotencyKey } : {}),
    error: { name: error instanceof Error ? error.name : 'Error',
      code: typeof error?.code === 'string' ? error.code : error?.details?.errorCode ?? 'RABI_OPERATION_FAILED',
      message: error instanceof Error ? error.message : String(error) },
    ...(error?.details === undefined ? {} : { details: error.details }),
    ...(receipt === undefined ? {} : { receipt }),
  })
}

/**
 * Create one plugin-owned adapter; the transport retains Manager identity and authentication.
 * @param dependencies - Shared SDK request and optional streaming/WebSocket connectors.
 * @param options - DSH execution timeout matching the configured request budget.
 * @returns The six DSH definitions and an idempotent session/cancellation disposer.
 */
export function createOperationToolRuntime(dependencies, { requestTimeoutMs = 60000 } = {}) {
  const lifetime = new AbortController()
  let closed = false, closeFlight
  const scoped = options => ({ ...options, signal: options?.signal
    ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal })
  const transport = { ...dependencies }
  for (const name of ['request', 'requestExternal']) if (typeof dependencies?.[name] === 'function') {
    transport[name] = (method, target, options = {}, ...rest) => dependencies[name](method, target, scoped(options), ...rest)
  }
  for (const name of ['openWebSocket', 'openExternalWebSocket']) if (typeof dependencies?.[name] === 'function') {
    transport[name] = (target, options = {}, ...rest) => dependencies[name](target, scoped(options), ...rest)
  }
  const sdk = createOperationSdk(transport)
  const owner = createOperationTools({ client: { operations: sdk } })
  const definitions = OPERATION_TOOL_DEFINITIONS.map(definition => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema,
    timeoutMs: requestTimeoutMs + 1000,
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(args, exec = {}) {
      if (closed) return failure(Object.assign(new Error('This Rabi tool scope is closed; retain the original request and receipt.'),
        { code: 'RABI_OPERATION_SCOPE_CLOSED' }), args, definition.readOnly)
      try {
        const result = await owner.call(definition.name, args, { signal: exec.signal
          ? AbortSignal.any([lifetime.signal, exec.signal]) : lifetime.signal })
        if (closed) return failure(Object.assign(new Error('The Rabi tool scope closed during the request; do not replay it.'),
          { code: 'RABI_OPERATION_SCOPE_CLOSED' }), args, definition.readOnly, true)
        return jsonResult(result)
      } catch (error) { return failure(error, args, definition.readOnly, lifetime.signal.aborted || exec.signal?.aborted) }
    },
  }))
  return Object.freeze({ definitions, close() {
    if (!closeFlight) {
      closed = true
      lifetime.abort(new Error('Rabi operation tool scope disposed.'))
      sdk.invalidate()
      closeFlight = Promise.resolve(owner.close())
    }
    return closeFlight
  } })
}

/**
 * Register through DSH effects; disposal closes the shared owner's live sessions.
 * @param ctx - The DSH tools service and effect owner.
 * @param dependencies - Existing Manager request and optional stream connectors.
 * @param options - The configured DSH execution timeout.
 * @returns The plugin-owned runtime and disposer.
 */
export function installOperationTools(ctx, dependencies, options) {
  const runtime = createOperationToolRuntime(dependencies, options)
  ctx.effect(() => () => runtime.close())
  for (const definition of runtime.definitions) ctx.effect(() => ctx.tools.register(definition))
  return runtime
}
