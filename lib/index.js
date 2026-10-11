import { createWorkspacePlans, createWorkspacePlansHandler, WORKSPACE_PLANS_PATH } from './workspace-plans.js'
import { createPlanAdvanceHost, PLAN_ADVANCE_PATH } from './plan-advance.js'
import { installPlanContext } from './plan-context.js'
import { installPlanResources } from './plan-resources-install.js'
import { createPlanStatusCache, createPlanStatusHandler, PLAN_STATUS_PATH } from './plan-status.js'
import { createPlanEventRelay, PLAN_EVENTS_PATH } from './plan-events.js'
import { createWorkspaceSkillProvider } from './workspace-skills.js'
import z from '@deepseek-ai/schemastery'
import { cleanBaseUrl, managerRequest, timeoutBudget } from './connection.js'
import { createPlanPanelHandler, PLAN_PANEL_PATH } from './plan-panel.js'
import { createLocateAgentHandler, LOCATE_AGENT_PATH } from './locate-agent.js'
import { createSpeechHandler, SPEECH_PATH } from './speech.js'
import { createAsrHandler, SPEECH_ASR_PATH } from './speech-asr.js'
import { rabiAssistantPreset } from './assistant-preset.js'
import { installNativeHooks } from './native-hooks.js'

export const Config = z.object({
  agentHooksEnabled: z.boolean().default(true),
  managerBaseUrl: z.string().default(''),
  hostExecutable: z.string().default(''),
  enforceAgentCommunication: z.boolean().default(true),
  requestTimeoutMs: z.number().default(30000),
  workspaceSkillsEnabled: z.boolean().default(true),
  workspacePlanCachePages: z.number().min(1).max(256).step(1).default(32),
  workspacePlanEventDelayMs: z.number().min(50).max(10000).step(1).default(200),
  planAdvanceStartupDelayMs: z.number().min(1000).max(300000).step(1).default(10000),
  planAdvanceEventDelayMs: z.number().min(200).max(30000).step(1).default(1000),
  planAdvanceReconnectMs: z.number().min(1000).max(300000).step(1).default(15000),
  planAdvanceDueCheckMs: z.number().min(10000).max(3600000).step(1).default(60000),
  workspaceSkillCacheMs: z.number().min(1).max(2147483647).step(1).default(30000),
  planContextEnabled: z.boolean().default(true),
  planResourcesEnabled: z.boolean().default(true),
  planResourcesDirectory: z.string().default(''),
  planResourceRetryMs: z.number().min(1000).max(3600000).step(1).default(30000),
  planResourceTimeoutMs: z.number().min(1000).max(12000).step(1).default(12000),
  planResourceMaxBytes: z.number().min(1).max(10485760).step(1).default(10485760),
  planContextMaxPlans: z.number().min(1).max(100).step(1).default(16),
  planContextTextLimit: z.number().min(80).max(2000).step(1).default(300),
  planStatusCacheMs: z.number().min(10000).max(3600000).step(1).default(60000),
  planStatusTimeoutMs: z.number().min(1000).max(300000).step(1).default(120000),
  planStatusMaxPages: z.number().min(1).max(100).step(1).default(24),
  speechTimeoutMs: z.number().default(300000),
})
export const RABIROUTE_AGENT_PLUGIN_ID = 'rabiroute-agent'
export const RABIROUTE_AGENT_PLUGIN_NAME = 'RabiRoute Agent'
export const RABIROUTE_AGENT_PLUGIN_VERSION = '0.13.27'
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

function validatePath(value) {
  const pathname = String(value || '').trim()
  if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\\#\s\u0000-\u001f]/u.test(pathname)) throw new Error('Manager API path must be a same-origin relative path without whitespace or fragments.')
  const raw = pathname.split('?')[0]
  let decoded
  try { decoded = decodeURIComponent(raw) } catch { throw new Error('Invalid Manager path encoding.') }
  // Encoded resource IDs remain valid; nested encoding must not hide traversal.
  let inspected = decoded
  for (;;) {
    if (/[\\\u0000-\u0020]/u.test(inspected) || inspected.split('/').some(part => part === '.' || part === '..')) throw new Error('Manager path traversal or encoded control character is not allowed.')
    let next
    try { next = decodeURIComponent(inspected) } catch { break }
    if (next === inspected) break
    inspected = next
  }
  return { pathname, decoded }
}
function requestHeaders(value) {
  const input = value ? parseJsonObject(value, 'requestHeadersJson') : {}
  const headers = Object.create(null)
  for (const [key, val] of Object.entries(input)) {
    const name = key.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || typeof val !== 'string' || /[\r\n\u0000]/.test(val) || Object.hasOwn(headers, name)) throw new Error('Request headers require unique HTTP names and string values without control characters.')
    headers[name] = val
  }
  return headers
}
const output = {
  schema: { type: 'object', properties: {
    statusCode: { type: 'number' }, ok: { type: 'boolean' }, body: { type: 'string' }, etag: { type: 'string' }, uncertain: { type: 'boolean' },
    headers: { type: 'object', additionalProperties: true },
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
    { name: 'rabiroute_manager_api', description: 'Call any RabiRoute Manager API with no plugin endpoint allowlist. Discover current contracts with GET /api/agent/help. Rabi owns authorization, methods, parameters and write preconditions. Inspect full receipts and uncertainty before retrying.',
      parameters: { type: 'object', properties: {
        method: { type: 'string', description: 'HTTP method from the current Rabi API contract, including GET, HEAD, OPTIONS, POST, PUT, PATCH and DELETE.' }, path: { type: 'string', description: 'Any same-origin Manager relative path and encoded query; no endpoint allowlist.' },
        bodyJson: { type: 'string', description: 'Optional serialized JSON value.' },
        bodyText: { type: 'string', description: 'Optional raw text body; supply at most one body field.' },
        bodyBase64: { type: 'string', description: 'Optional base64 binary body; set Content-Type to the current Rabi contract.' },
        requestHeadersJson: { type: 'string', description: 'Optional JSON object of HTTP headers required by Rabi, including Idempotency-Key and If-Match.' },
      }, required: ['method', 'path'], additionalProperties: false },
      async execute(args, exec) {
        const method = String(args.method || '').trim().toUpperCase()
        if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method)) throw new Error('Invalid HTTP method.')
        const { pathname } = validatePath(args.path)
        const headers = requestHeaders(args.requestHeadersJson)
        const bodies = ['bodyJson', 'bodyText', 'bodyBase64'].filter(name => args[name] !== undefined)
        if (bodies.length > 1) throw new Error('Supply at most one request body field.')
        if (['GET', 'HEAD'].includes(method) && bodies.length) throw new Error('GET and HEAD requests cannot carry a body.')
        let body
        if (bodies[0] === 'bodyJson') {
          try { body = JSON.stringify(JSON.parse(args.bodyJson)) } catch { throw new Error('bodyJson must be valid JSON.') }
        } else if (bodies[0] === 'bodyText') {
          body = args.bodyText
          headers['content-type'] ??= 'text/plain; charset=utf-8'
        } else if (bodies[0] === 'bodyBase64') {
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.bodyBase64)) throw new Error('bodyBase64 must be valid padded base64.')
          body = Buffer.from(args.bodyBase64, 'base64')
          headers['content-type'] ??= 'application/octet-stream'
        }
        return managerRequest(config, pathname, { method, headers, ...(body !== undefined ? { body } : {}) }, exec.signal, dependencies)
      } },
  ]
  return definitions.map(definition => ({ ...definition, output, timeoutMs }))
}
function promptText(config) {
  return [
    '[RabiRoute DSH 主 Agent]',
    '当前 DSH 会话可以作为 RabiRoute 的主人格、计划秘书、消息处理 Agent、记忆整理 Agent 或独立业务 Agent。',
    '主人格与协调会话直接处理消息、计划和任务跟进；其他业务工作尽量通过 rabiroute_agent_threads 安排独立会话，先复用同一事项的原任务，没有合适任务时再创建。委派写清目标、必要背景、约束、已有授权、验收标准和回报要求，保存 threadId、requestId 及关联 planId。',
    '独立会话是提示词中的优先分工，不是接口权限限制。当前会话始终可调用 Rabi 全部接口，必要的上下文和状态核对可直接进行；用户要求直接处理或简单已授权动作可以直接调用。已经受领独立业务任务的会话完成自己的工作并回报，不把同一目标层层转派。',
    'RabiRoute 的计划、秘书绑定、消息处理看板和记忆结果由 Manager 持有；不要在 DSH 内复制第二份业务真源。',
    'Agent 会话发现、创建、改名、绑定、投递和正式回复统一使用 rabiroute_agent_threads。',
    'Agent 间投递必须填写完整来源会话 ID、来源 Agent 类型、responsePolicy；要求回复时填写 responseInstruction，正式回复时填写 inReplyToRequestId、result 和 nextAction。',
    '插件只向 Manager 发送 messageSource；来源会话必须与 sourceThreadId 相同。',
    '向 QQ、语音、飞书、RabiLink 等消息端发送内容时使用 rabiroute_agent_send，并取得 Manager 与渠道回执。最终文本不算已发送。',
    '计划、消息处理、回复请求、记忆和桌宠移动使用 rabiroute_manager_api。桌宠移动先读 /api/agent/help 对应 motion 合同，提交后按原 requestId 查询实际抵达回执。secretaryBinding 只记录秘书，taskBinding 只记录独立业务任务。',
    'rabiroute_manager_api 可调用 Rabi 的全部接口，没有插件路径、方法或业务请求头白名单；接口方法、参数、鉴权、幂等与版本条件由 Rabi 校验。先读 /api/agent/help 当前合同，新增接口无需更新本插件。调用能力不扩大当前用户授权，外发、设备动作、删除与付费遵守 Rabi Action Gate。',
    '家庭设备先读 /api/agent/xiaomi-home/devices?q=<URL编码关键词>&limit=5 或 /resources?kind=climate&limit=5 等摘要小页，默认不带完整属性。q 支持名称、描述、型号、房间与属性信息，多词空格分隔；kind 筛实体类型，available=1 筛在线项。结果为 data.items、total、nextOffset，nextOffset 非空时带同样筛选和 offset 继续；不要把第一页当全部清单，也不要默认批量 includeActions=1。',
    '设备摘要给出 deviceId 和 resourcesPath；按 /resources?deviceId=<编码deviceId>&limit=5 继续筛选实体，无归属实体使用 deviceId=unassigned。需要更多目录字段可显式 view=detail，仍按页读；单项 /devices/<编码deviceId> 读完整登记信息。定位 resourceId 后只读 /resources/<编码resourceId> 的实时状态，再按 /entity-actions?resourceId=<编码resourceId> 获取该实体动作和参数。列表摘要不是完整状态，输出截断时缩小 limit 或关键词，不使用网页或本地缓存补读。requestHeadersJson 传稳定 Idempotency-Key；插件自动附加本次核验的代际头。按原键查询 /action-requests?idempotencyKey=<原键>，accepted 不等于设备结果已确认。',
    'DSH 投递失败时报告失败，不改投 Codex，也不创建另一套任务。',
    config.managerBaseUrl ? 'Rabi Manager 使用插件显式配置的完整地址并逐次核对身份。' : 'Rabi Manager 每项操作从 Host 动态发现并核对 /meta，不使用历史端口。',
    '可用 GET /meta 只读核对连接。旧地址失败不代表 Manager 离线；不要用读取近期记忆作为无副作用健康探针。',
    '存储写入先读现行接口合同。requestHeadersJson 传稳定 Idempotency-Key 和适用的强 ETag If-Match；检查完整输出的 HTTP 状态、回显键、ETag、资源身份和 uncertain。',
    '超时、503、写后切代或回执不确定时保留原键和原正文，先权威读回，不自动重发。412 重新读后确认原意再用新键与新 ETag。',
  ].join('\n')
}
export function apply(ctx, config = {}) {
  ctx.inject(['agentPresets'], runtime => {
    runtime.effect(() => runtime.agentPresets.register(rabiAssistantPreset))
  })
  const status = createRabiRouteAgentRuntimeStatus(config)
  const resolved = { ...config, managerBaseUrl: status.managerBaseUrl, enforceAgentCommunication: status.enforceAgentCommunication, requestTimeoutMs: status.requestTimeoutMs }
  if (resolved.agentHooksEnabled !== false) ctx.inject(['sessionProjections', 'workingDirectory'], runtime => installNativeHooks(runtime, resolved))
  const statusCache = createPlanStatusCache(resolved)
  ctx.effect(() => () => statusCache.dispose())
  if (resolved.planContextEnabled !== false) ctx.inject(['systemPrompt'], runtime => installPlanContext(runtime, statusCache, resolved))
  if (resolved.planResourcesEnabled !== false) ctx.inject(['systemPrompt', 'tools', 'attachments'], runtime => {
    installPlanResources(runtime, resolved, statusCache)
    status.tools.push('rabiroute_plan_resources')
    runtime.effect(() => () => { status.tools = status.tools.filter(name => name !== 'rabiroute_plan_resources') })
  })
  ctx.inject(['webServer', 'sessionController'], web => {
    const read = createWorkspacePlans(resolved, async signal => (await web.sessionController.list({}, signal)).items)
    web.webServer.register({ kind: 'exact', path: WORKSPACE_PLANS_PATH, handler: createWorkspacePlansHandler(read) })
    const advance = createPlanAdvanceHost(resolved, async () => (await web.sessionController.list({})).items, read)
    web.webServer.register({ kind: 'exact', path: PLAN_ADVANCE_PATH, handler: advance.handler })
    web.on('session/event', (session, event) => { if (event.type === 'turn/end') advance.enqueue({ trigger: 'idle', sessionId: session.id }) })
    web.effect(() => { advance.start(); return () => advance.dispose() })
  })
  // Rabi has no DSH CORS policy. Optional same-origin routes adapt its plan,
  // window navigation, TTS and ASR APIs for the browser.
  ctx.inject(['webServer'], web => {
    web.webServer.register({ kind: 'exact', path: PLAN_STATUS_PATH, handler: createPlanStatusHandler(statusCache) })
    const eventRelay = createPlanEventRelay(resolved, statusCache)
    web.effect(() => () => eventRelay.dispose())
    web.webServer.register({ kind: 'exact', path: PLAN_EVENTS_PATH, handler: eventRelay.handler })
    web.webServer.register({ kind: 'exact', path: PLAN_PANEL_PATH, handler: createPlanPanelHandler(resolved) })
    web.webServer.register({ kind: 'exact', path: LOCATE_AGENT_PATH, handler: createLocateAgentHandler(resolved) })
    web.webServer.register({ kind: 'exact', path: SPEECH_PATH, handler: createSpeechHandler(resolved) })
    web.webServer.register({ kind: 'exact', path: SPEECH_ASR_PATH, handler: createAsrHandler(resolved) })
  })
  if (config.workspaceSkillsEnabled !== false) ctx.inject(['skills'], runtime => {
    runtime.skills.registerProvider(control => createWorkspaceSkillProvider(resolved, control))
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
export const internals = { normalizeThreadRequest, promptText, toolDefinitions, validatePath, requestHeaders, createPlanPanelHandler, PLAN_PANEL_PATH, createLocateAgentHandler, LOCATE_AGENT_PATH, createAsrHandler, SPEECH_ASR_PATH }
