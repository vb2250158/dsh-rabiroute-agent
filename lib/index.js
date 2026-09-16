import z from '@deepseek-ai/schemastery'
import { cleanBaseUrl, managerRequest, timeoutBudget } from './connection.js'
import { createPlanPanelHandler, PLAN_PANEL_PATH } from './plan-panel.js'

export const Config = z.object({
  managerBaseUrl: z.string().default(''),
  hostExecutable: z.string().default(''),
  enforceAgentCommunication: z.boolean().default(true),
  requestTimeoutMs: z.number().default(30000),
})
export const RABIROUTE_AGENT_PLUGIN_ID = 'rabiroute-agent'
export const RABIROUTE_AGENT_PLUGIN_NAME = 'RabiRoute Agent'
export const RABIROUTE_AGENT_PLUGIN_VERSION = '0.2.0'
export const RABIROUTE_AGENT_TOOL_NAMES = Object.freeze(['rabiroute_agent_threads', 'rabiroute_agent_send', 'rabiroute_manager_api'])
const THREADS_PATH = '/api/agent/threads'
const SEND_PATH = '/api/agent/send'
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'powershell', 'terminal'])

export function createRabiRouteAgentRuntimeStatus(config = {}) {
  return { id: RABIROUTE_AGENT_PLUGIN_ID, name: RABIROUTE_AGENT_PLUGIN_NAME, version: RABIROUTE_AGENT_PLUGIN_VERSION, active: false,
    managerBaseUrl: cleanBaseUrl(config.managerBaseUrl), enforceAgentCommunication: config.enforceAgentCommunication !== false,
    requestTimeoutMs: timeoutBudget(config.requestTimeoutMs), tools: [...RABIROUTE_AGENT_TOOL_NAMES] }
}
function parseJsonObject(value, field) {
  let parsed
  try { parsed = JSON.parse(String(value || '')) } catch { throw new Error(field + ' must be valid JSON.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(field + ' must contain a JSON object.')
  return parsed
}
function normalizeThreadRequest(request) {
  const raw = request.messageSource || request.deliverySource
  if (!raw) return request
  if (request.messageSource && request.deliverySource && request.messageSource.sessionId !== request.deliverySource.sessionId) throw new Error('Conflicting messageSource and legacy deliverySource sessionId.')
  const agentAdapter = String(raw.agentAdapter || '').trim()
  const sessionId = String(raw.sessionId || '').trim()
  if (!agentAdapter || !sessionId) throw new Error('Agent source requires agentAdapter and sessionId.')
  if (request.sourceThreadId && request.sourceThreadId !== sessionId) throw new Error('messageSource.sessionId must match sourceThreadId.')
  const { deliverySource: _legacy, ...rest } = request
  return { ...rest, messageSource: { type: 'agent', agentAdapter, sessionId, sessionName: String(raw.sessionName || sessionId).trim(), agentType: String(raw.agentType || request.sourceAgentType || 'agent').trim(), ...(raw.workspace ? { workspace: String(raw.workspace) } : {}) } }
}

function validatePath(value, method) {
  const pathname = String(value || '').trim()
  if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\\#\s\u0000-\u001f]/u.test(pathname)) throw new Error('Manager API path is outside the allowlist.')
  const raw = pathname.split('?')[0]
  let decoded
  try { decoded = decodeURIComponent(raw) } catch { throw new Error('Invalid Manager path encoding.') }
  // Reject encoded separators, repeated encoding and traversal before URL normalization.
  if (/[\\%?#\u0000-\u0020]/u.test(decoded) || /%2f/i.test(raw) || decoded.split('/').some(part => part === '.' || part === '..')) throw new Error('Manager path traversal or encoded separator is not allowed.')
  const health = decoded === '/meta'
  const receipt = /^\/api\/agent\/send\/receipts\/[^/]+$/.test(decoded) || decoded === '/api/agent/send/traces'
  if ((health || receipt) && method !== 'GET') throw new Error('Health and receipt endpoints are GET-only.')
  const allowed = /^\/api\/(?:roles|message-processing|memory)\/[^/]+(?:\/.*)?$/.test(decoded) || /^\/api\/agent\/requests(?:\/[^/]+)*$/.test(decoded)
  if (!health && !receipt && !allowed) throw new Error('Manager API path is outside the RabiRoute plugin allowlist; use dedicated delivery tools for sending.')
  return { pathname, decoded }
}
function requestHeaders(value) {
  const input = value ? parseJsonObject(value, 'requestHeadersJson') : {}
  const headers = {}
  for (const [key, val] of Object.entries(input)) {
    const name = key.toLowerCase()
    if (!['if-match', 'idempotency-key'].includes(name) || typeof val !== 'string' || !val.trim() || /[\r\n]/.test(val) || Object.hasOwn(headers, name)) throw new Error('Only unique nonempty If-Match and Idempotency-Key headers are allowed.')
    if (name === 'if-match' && !/^"[^"\r\n]+"$/.test(val)) throw new Error('If-Match must contain one strong ETag from the authoritative GET.')
    headers[name] = val
  }
  return headers
}
function validateStorageHeaders(method, pathname, headers) {
  const create = method === 'POST' && /^\/api\/roles\/[^/]+\/(?:plans|memory\/recent|memory\/consolidation-requests)$/.test(pathname)
  const versioned = (method === 'PATCH' && /^\/api\/roles\/[^/]+\/(?:plans|memory\/recent)\/[^/]+$/.test(pathname))
    || (method === 'POST' && /^\/api\/roles\/[^/]+\/(?:plans\/[^/]+\/feedback|memory\/consolidation-runs\/[^/]+\/result|plan-(?:marker-)?statuses)$/.test(pathname))
    || (['PATCH', 'DELETE'].includes(method) && /^\/api\/roles\/[^/]+\/plan-(?:marker-)?statuses\/[^/]+$/.test(pathname))
  if ((create || versioned) && !headers['idempotency-key']) throw new Error('This storage write requires a stable Idempotency-Key.')
  if (versioned && !headers['if-match']) throw new Error('This versioned storage write requires If-Match from the authoritative GET.')
}

const output = {
  schema: { type: 'object', properties: {
    statusCode: { type: 'number' }, ok: { type: 'boolean' }, body: { type: 'string' }, etag: { type: 'string' }, uncertain: { type: 'boolean' },
    headers: { type: 'object', properties: { etag: { type: 'string' }, 'idempotency-key': { type: 'string' }, 'retry-after': { type: 'string' } }, additionalProperties: false },
    identity: { type: 'object', properties: { applicationGenerationId: { type: 'string' }, managerInstanceId: { type: 'string' } }, required: ['applicationGenerationId', 'managerInstanceId'], additionalProperties: false },
    error: { type: 'object', properties: { kind: { type: 'string' }, message: { type: 'string' } }, required: ['kind', 'message'], additionalProperties: false },
  }, required: ['statusCode', 'ok', 'body'], additionalProperties: false },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
function toolDefinitions(config, dependencies = {}) {
  const timeoutMs = timeoutBudget(config.requestTimeoutMs) + 1000
  const definitions = [
    { name: 'rabiroute_agent_threads', description: 'Use the RabiRoute Manager thread bridge to list, read, resolve, create, rename, or send Agent sessions. Required for formal Agent-to-Agent delivery and replies.',
      parameters: { type: 'object', properties: { requestJson: { type: 'string', description: 'Complete /api/agent/threads JSON request.' } }, required: ['requestJson'], additionalProperties: false },
      async execute(args, exec) { const request = normalizeThreadRequest(parseJsonObject(args.requestJson, 'requestJson')); return managerRequest(config, THREADS_PATH, { method: 'POST', body: JSON.stringify(request) }, exec.signal, dependencies) } },
    { name: 'rabiroute_agent_send', description: 'Send a message through a configured RabiRoute message adapter. A successful Manager and channel receipt is the only proof that the message was sent.',
      parameters: { type: 'object', properties: { requestJson: { type: 'string', description: 'Complete /api/agent/send JSON request.' } }, required: ['requestJson'], additionalProperties: false },
      async execute(args, exec) { return managerRequest(config, SEND_PATH, { method: 'POST', body: JSON.stringify(parseJsonObject(args.requestJson, 'requestJson')) }, exec.signal, dependencies) } },
    { name: 'rabiroute_manager_api', description: 'Read or update allowlisted RabiRoute plans, memory and processing APIs. GET /meta checks health. Pass version/idempotency headers for storage writes; inspect full receipts and uncertainty before retrying.',
      parameters: { type: 'object', properties: {
        method: { type: 'string', description: 'GET, POST, PUT, PATCH, or DELETE.' }, path: { type: 'string', description: 'Allowlisted Manager path; health and sending receipts are GET-only.' },
        bodyJson: { type: 'string', description: 'Optional JSON object body.' }, requestHeadersJson: { type: 'string', description: 'Optional JSON object containing only If-Match and Idempotency-Key.' },
      }, required: ['method', 'path'], additionalProperties: false },
      async execute(args, exec) {
        const method = String(args.method || '').trim().toUpperCase()
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported Manager API method.')
        const { pathname, decoded } = validatePath(args.path, method)
        const headers = requestHeaders(args.requestHeadersJson)
        validateStorageHeaders(method, decoded, headers)
        if (method === 'GET' && args.bodyJson) throw new Error('GET requests cannot carry a body.')
        const body = args.bodyJson ? JSON.stringify(parseJsonObject(args.bodyJson, 'bodyJson')) : undefined
        return managerRequest(config, pathname, { method, headers, ...(body ? { body } : {}) }, exec.signal, dependencies)
      } },
  ]
  return definitions.map(definition => ({ ...definition, output, timeoutMs }))
}
function promptText(config) {
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
    config.managerBaseUrl ? 'Rabi Manager 使用插件显式配置的完整地址并逐次核对身份。' : 'Rabi Manager 每项操作从 Host 动态发现并核对 /meta，不使用历史端口。',
    '可用 GET /meta 只读核对连接。旧地址失败不代表 Manager 离线；不要用读取近期记忆作为无副作用健康探针。',
    '存储写入先读现行接口合同。requestHeadersJson 传稳定 Idempotency-Key 和适用的强 ETag If-Match；检查完整输出的 HTTP 状态、回显键、ETag、资源身份和 uncertain。',
    '超时、503、写后切代或回执不确定时保留原键和原正文，先权威读回，不自动重发。412 重新读后确认原意再用新键与新 ETag。',
  ].join('\n')
}
export function apply(ctx, config = {}) {
  const status = createRabiRouteAgentRuntimeStatus(config)
  const resolved = { ...config, managerBaseUrl: status.managerBaseUrl, enforceAgentCommunication: status.enforceAgentCommunication, requestTimeoutMs: status.requestTimeoutMs }
  // The plan panel's own same-origin route: the browser cannot reach Rabi directly
  // (Rabi declares no CORS policy for the DSH origin), so the Host answers for it.
  // A composition without an HTTP carrier simply never registers the route.
  ctx.inject(['webServer'], web => {
    web.webServer.register({ kind: 'exact', path: PLAN_PANEL_PATH, handler: createPlanPanelHandler(resolved) })
  })
  ctx.inject(['tools', 'systemPrompt'], runtime => {
    runtime.systemPrompt.section({ name: 'rabiroute:agent-contract', order: 25, text: promptText(resolved) })
    for (const definition of toolDefinitions(resolved)) runtime.tools.register(definition)
    if (resolved.enforceAgentCommunication) runtime.on('tools/pre-execute', (exec, next) => {
      if (!SHELL_TOOLS.has(exec.name)) return next()
      if (/\/api\/agent\/(?:threads|send)|session\.prompt/i.test(JSON.stringify(exec.arguments || {}))) return Promise.resolve({ kind: 'deny', reason: 'Use the RabiRoute plugin tools for Agent communication and external sending.' })
      return next()
    })
    status.active = true
  })
  return status
}
export const internals = { normalizeThreadRequest, promptText, toolDefinitions, validatePath, requestHeaders, validateStorageHeaders, createPlanPanelHandler, PLAN_PANEL_PATH }
