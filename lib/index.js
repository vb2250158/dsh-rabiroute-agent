import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  managerBaseUrl: z.string().default('http://127.0.0.1:8790'),
  enforceAgentCommunication: z.boolean().default(true),
  requestTimeoutMs: z.number().default(30000),
})

const THREADS_PATH = '/api/agent/threads'
const SEND_PATH = '/api/agent/send'
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'powershell', 'terminal'])
export const RABIROUTE_AGENT_PLUGIN_ID = 'rabiroute-agent'
export const RABIROUTE_AGENT_PLUGIN_NAME = 'RabiRoute Agent'
export const RABIROUTE_AGENT_PLUGIN_VERSION = '0.1.4'
export const RABIROUTE_AGENT_TOOL_NAMES = Object.freeze([
  'rabiroute_agent_threads',
  'rabiroute_agent_send',
  'rabiroute_manager_api',
])

const ALLOWED_MANAGER_PREFIXES = [
  '/api/roles/',
  '/api/message-processing/',
  '/api/agent/requests',
  '/api/memory/',
]

function cleanBaseUrl(value) {
  const text = String(value || 'http://127.0.0.1:8790').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(text)) throw new Error('managerBaseUrl must be an http or https URL.')
  return text
}

export function createRabiRouteAgentRuntimeStatus(config = {}) {
  return {
    id: RABIROUTE_AGENT_PLUGIN_ID,
    name: RABIROUTE_AGENT_PLUGIN_NAME,
    version: RABIROUTE_AGENT_PLUGIN_VERSION,
    active: false,
    managerBaseUrl: cleanBaseUrl(config.managerBaseUrl),
    enforceAgentCommunication: config.enforceAgentCommunication !== false,
    requestTimeoutMs: Math.max(1000, Math.floor(Number(config.requestTimeoutMs) || 30000)),
    tools: [...RABIROUTE_AGENT_TOOL_NAMES],
  }
}

function parseJsonObject(value, field) {
  let parsed
  try { parsed = JSON.parse(String(value || '')) } catch { throw new Error(field + ' must be valid JSON.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(field + ' must contain a JSON object.')
  return parsed
}

function agentSourceFromRequest(request) {
  const source = request.messageSource && typeof request.messageSource === 'object'
    ? request.messageSource
    : request.deliverySource && typeof request.deliverySource === 'object'
      ? request.deliverySource
      : undefined
  if (!source) return undefined
  const agentAdapter = String(source.agentAdapter || '').trim()
  const sessionId = String(source.sessionId || '').trim()
  const sessionName = String(source.sessionName || sessionId).trim()
  if (!agentAdapter || !sessionId || !sessionName) throw new Error('Agent source requires agentAdapter, sessionId, and sessionName.')
  return {
    type: 'agent',
    agentAdapter,
    agentType: String(source.agentType || request.sourceAgentType || 'agent').trim(),
    sessionId,
    sessionName,
    ...(source.workspace ? { workspace: String(source.workspace) } : {}),
  }
}

function normalizeThreadRequest(request) {
  const source = agentSourceFromRequest(request)
  if (!source) return request
  const { deliverySource: _legacyDeliverySource, ...rest } = request
  return {
    ...rest,
    messageSource: source,
  }
}

async function managerRequest(baseUrl, requestTimeoutMs, pathname, init, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Rabi Manager request timed out.')), requestTimeoutMs)
  const abort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(baseUrl + pathname, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
    })
    const body = await response.text()
    if (!response.ok) throw new Error('Rabi Manager HTTP ' + response.status + ': ' + body)
    let parsed
    try { parsed = body ? JSON.parse(body) : {} } catch { parsed = { text: body } }
    if (parsed && typeof parsed === 'object' && parsed.code === -1) {
      throw new Error(String(parsed.message || parsed.error?.message || 'Rabi Manager rejected the request.'))
    }
    return { statusCode: response.status, ok: true, body: JSON.stringify(parsed) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

const output = {
  schema: {
    type: 'object',
    properties: {
      statusCode: { type: 'number' },
      ok: { type: 'boolean' },
      body: { type: 'string' },
    },
    required: ['statusCode', 'ok', 'body'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: value.body }],
}

function toolDefinitions(config) {
  const baseUrl = cleanBaseUrl(config.managerBaseUrl)
  const requestTimeoutMs = Math.max(1000, Math.floor(Number(config.requestTimeoutMs) || 30000))
  return [
    {
      name: 'rabiroute_agent_threads',
      description: 'Use the RabiRoute Manager thread bridge to list, read, resolve, create, rename, or send Agent sessions. Required for formal Agent-to-Agent delivery and replies.',
      parameters: {
        type: 'object',
        properties: { requestJson: { type: 'string', description: 'Complete /api/agent/threads JSON request.' } },
        required: ['requestJson'],
        additionalProperties: false,
      },
      output,
      timeoutMs: requestTimeoutMs,
      async execute(args, exec) {
        const request = normalizeThreadRequest(parseJsonObject(args.requestJson, 'requestJson'))
        return managerRequest(baseUrl, requestTimeoutMs, THREADS_PATH, { method: 'POST', body: JSON.stringify(request) }, exec.signal)
      },
    },
    {
      name: 'rabiroute_agent_send',
      description: 'Send a message through a configured RabiRoute message adapter. A successful Manager and channel receipt is the only proof that the message was sent.',
      parameters: {
        type: 'object',
        properties: { requestJson: { type: 'string', description: 'Complete /api/agent/send JSON request.' } },
        required: ['requestJson'],
        additionalProperties: false,
      },
      output,
      timeoutMs: requestTimeoutMs,
      async execute(args, exec) {
        const request = parseJsonObject(args.requestJson, 'requestJson')
        return managerRequest(baseUrl, requestTimeoutMs, SEND_PATH, { method: 'POST', body: JSON.stringify(request) }, exec.signal)
      },
    },
    {
      name: 'rabiroute_manager_api',
      description: 'Read or update RabiRoute plans, message-processing requirements, Agent reply requests, and memory-control endpoints through an allowlisted Manager path.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'GET, POST, PUT, or PATCH.' },
          path: { type: 'string', description: 'Manager API path beginning with an allowed prefix.' },
          bodyJson: { type: 'string', description: 'Optional JSON object body.' },
        },
        required: ['method', 'path'],
        additionalProperties: false,
      },
      output,
      timeoutMs: requestTimeoutMs,
      async execute(args, exec) {
        const method = String(args.method || '').trim().toUpperCase()
        if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method)) throw new Error('Unsupported Manager API method.')
        const pathname = String(args.path || '').trim()
        if (!pathname.startsWith('/') || !ALLOWED_MANAGER_PREFIXES.some(prefix => pathname.startsWith(prefix))) {
          throw new Error('Manager API path is outside the RabiRoute plugin allowlist.')
        }
        if (pathname.startsWith(THREADS_PATH) || pathname.startsWith(SEND_PATH)) {
          throw new Error('Use rabiroute_agent_threads or rabiroute_agent_send for this endpoint.')
        }
        const body = args.bodyJson ? JSON.stringify(parseJsonObject(args.bodyJson, 'bodyJson')) : undefined
        return managerRequest(baseUrl, requestTimeoutMs, pathname, { method, ...(body ? { body } : {}) }, exec.signal)
      },
    },
  ]
}

function promptText(config) {
  const baseUrl = cleanBaseUrl(config.managerBaseUrl)
  return [
    '[RabiRoute DSH 主 Agent]',
    '当前 DSH 会话可以作为 RabiRoute 的主人格、计划秘书、消息处理 Agent、记忆整理 Agent 或独立业务 Agent。',
    'RabiRoute 的计划、秘书绑定、消息处理看板和记忆结果由 Manager 持有；不要在 DSH 内复制第二份业务真源。',
    'Agent 会话发现、创建、改名、绑定、投递和正式回复统一使用 rabiroute_agent_threads。',
    'Agent 间投递必须填写完整来源会话 ID、来源 Agent 类型、responsePolicy；要求回复时填写 responseInstruction，正式回复时填写 inReplyToRequestId、result 和 nextAction。',
    '插件只向 Manager 发送 messageSource；来源会话必须与 sourceThreadId 相同。',
    '向 QQ、语音、飞书、RabiLink 等消息端发送内容时使用 rabiroute_agent_send，并取得 Manager 与渠道回执。最终文本不算已发送。',
    '计划、消息处理、回复请求和记忆控制使用 rabiroute_manager_api。secretaryBinding 只记录秘书，taskBinding 只记录独立业务任务。',
    'DSH 投递失败时报告失败，不改投 Codex，也不创建另一套任务。',
    'Rabi Manager：' + baseUrl,
  ].join('\n')
}

export function apply(ctx, config = {}) {
  const status = createRabiRouteAgentRuntimeStatus(config)
  const resolved = {
    managerBaseUrl: status.managerBaseUrl,
    enforceAgentCommunication: status.enforceAgentCommunication,
    requestTimeoutMs: status.requestTimeoutMs,
  }
  ctx.inject(['tools', 'systemPrompt'], runtime => {
    runtime.systemPrompt.section({ name: 'rabiroute:agent-contract', order: 25, text: promptText(resolved) })
    for (const definition of toolDefinitions(resolved)) runtime.tools.register(definition)
    if (resolved.enforceAgentCommunication) {
      runtime.on('tools/pre-execute', (exec, next) => {
        if (!SHELL_TOOLS.has(exec.name)) return next()
        const text = JSON.stringify(exec.arguments || {})
        if (/\/api\/agent\/(?:threads|send)|session\.prompt/i.test(text)) {
          return Promise.resolve({ kind: 'deny', reason: 'Use the RabiRoute plugin tools for Agent communication and external sending.' })
        }
        return next()
      })
    }
    status.active = true
  })
  return status
}

export const internals = { normalizeThreadRequest, promptText, toolDefinitions }
