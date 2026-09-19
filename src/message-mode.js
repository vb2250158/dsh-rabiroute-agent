import { RABIROUTE_AGENT_TOOL_NAMES, internals } from './index.js'

/** This preset requires the host Rabi tools so it shares their connection config. */
export const inject = ['tools', 'systemPrompt']
const allowedTools = new Set(RABIROUTE_AGENT_TOOL_NAMES)
const denied = '消息处理模式仅允许 Rabi 消息、会话、计划、记忆和人格 Skill 接口；禁止命令执行和通用文件访问。'

/** Reject file payloads while leaving message text and session workspace metadata intact. */
function hasFilePayload(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasFilePayload)
  return Object.entries(value).some(([key, item]) =>
    (['path', 'filePath', 'localPath', 'contentBase64'].includes(key) && item != null && item !== '')
    || (['attachments', 'imagePaths', 'filePaths'].includes(key) && Array.isArray(item) && item.length > 0)
    || (key === 'type' && ['file', 'image', 'voice', 'localImage'].includes(item))
    || hasFilePayload(item))
}

/** Return a denial before dispatch; malformed JSON is rejected by the owning tool. */
export function messageModeGuard(exec) {
  if (!allowedTools.has(exec.name)) return denied
  const args = exec.arguments
  if (exec.name === 'rabiroute_manager_api') {
    let path
    try { path = internals.validatePath(args.path, String(args.method).trim().toUpperCase()).decoded }
    catch (error) { return error.message }
    // File downloads are not plan metadata; they must not become a filesystem bypass.
    if (path.split('/').some(part => ['attachments', 'files', 'download', 'upload'].includes(part.toLowerCase()))) return denied
  }
  const json = exec.name === 'rabiroute_manager_api' ? args.bodyJson : args.requestJson
  if (json) {
    let value
    try { value = JSON.parse(json) } catch { return 'Rabi request must be valid JSON.' }
    if (hasFilePayload(value)) return denied
  }
}

/** Mount only in a preset scope. Restriction and guard disposers follow that scope. */
export function apply(ctx) {
  if (typeof ctx.tools.guard !== 'function' || typeof ctx.tools.restrict !== 'function' || typeof ctx.tools.presentAs !== 'function') {
    throw new Error('消息处理模式需要支持 tools.guard、tools.restrict 和 tools.presentAs 的 DSH；请先更新宿主。')
  }
  // Missing host tools fail at mount rather than exposing a partly working mode.
  ctx.tools.restrict({ allow: RABIROUTE_AGENT_TOOL_NAMES })
  ctx.tools.presentAs('native')
  ctx.tools.guard(messageModeGuard)
  ctx.systemPrompt.section({ name: 'rabiroute:message-mode', order: 26, text: messageModePrompt })
}

/** Build logged operating guidance with the actual caller identity, never another session's cached identity. */
export function messageModePrompt({ agent } = {}) {
  const sessionId = agent?.session.id
  const caller = sessionId ? JSON.stringify({ agentAdapter: 'dsh', sessionId, workspace: agent.session.header.cwd }) : null
  return [
    '[消息处理模式]',
    '你是专职协调者：接收消息、理解诉求、拆分任务、选择执行 Agent、派发与跟进、核对回报、维护 Rabi 计划和记忆，并以当前人格回复。',
    '所有具体业务工作都交给其他 Agent，包括调查、检索、分析研究、定制方案、实现、测试和验收。即使不需要工具，也不要自行产出调查结论、专业方案、代码或替执行者完成任务；你只做协调决策、汇总已有证据和沟通。',
    '先通过 Rabi 读取与当前事项相关的记忆、计划及 Skill，完成 [处理前上下文确认] 的必读项，再安排工作；不要仅凭摘要猜正文。Rabi 是消息、人格、Skill、计划与记忆的唯一业务真源。',
    '先复用负责同一事项的已有 Agent，会话缺失时再创建。委派写清目标、背景、约束、授权范围、验收标准和回复要求，调查/方案/实施分阶段推进；无实施授权不让执行者改动或发布。不要把完整人格注入或其他任务的控制块复制给接收方。',
    '委派使用 responsePolicy=required，要求返回结果、证据、未完成项和 nextAction；保存回执中的 threadId、requestId 及关联 planId。根据返回结果决定补充调查、方案确认或下一步实施；任务不可用或信息不足时报告阻碍，不自己接手执行。',
    '任务已投递不等于已完成。用请求状态和任务回报跟进；交叉检查回报是否满足验收标准，进一步调查或验收也交给其他 Agent。仅有执行者声称成功时注明尚待核验，不编造已验证。',
    '及时更新计划步骤、绑定、阻碍和下一步；只把有来源的偏好、事实、决策和结论写入近期记忆，不把待确认方案写成事实。记忆沉淀等实际整理工作也委派，依据返回结果提交。',
    'Rabi 与人格 Skill 可以使用：经 rabiroute_manager_api 读取 Rabi 的技能列表和正文，遵守其中适用的人格表达、接口及协调规则。Skill 要求调查、设计、实施或命令/文件操作时，将该工作交给执行 Agent；加载 Skill 不扩大本模式权限。',
    '禁止命令执行、通用文件搜索、遍历、读取和写入，不下载或上传附件，不通过通用 skill、Shell、PTC 或其他工具绕过限制。Rabi 管理的人格正文、技能、记忆和计划属于获准的业务读取，使用对应 API；其底层保存成文件不影响调用权限。workspace/cwd 仅是会话路由信息。',
    '',
    '[Rabi 调用指南]',
    caller ? `当前真实调用方：${caller}。sourceThreadId 与 messageSource.sessionId 都必须使用这个 sessionId；messageSource.agentAdapter=dsh。先用 threads 的 read 读取自己取得真实 sessionName。` : '当前装配未提供会话身份。必须从实际会话上下文取得完整 ID，不根据任务标题猜测；无法确认时不要伪造投递来源。',
    'roleId 使用当前绑定人格或消息注入给出的 ID；缺少绑定时，可 GET /api/codex-hook/sessions/<当前sessionId> 查询。GET /api/personas 发现人格但不代表当前已绑定，不能自行任选人格。所有路径占位符用真实 ID 并按 URL 路径段编码。',
    'rabiroute_manager_api 参数：method、path，以及可选 bodyJson 和 requestHeadersJson；后两项都是 JSON 对象序列化后的字符串。path 使用下列 /api/... 相对路径；工具负责发现 Manager，不拼接旧端口。输出 body 是正文字符串，检查 HTTP 状态、ok、业务状态、etag 与 uncertain。',
    '人格与 Skill：GET /api/roles/<roleId>/persona-document；GET /api/roles/<roleId>/skills 获取元信息；GET /api/roles/<roleId>/skills/<skillId> 获取全文。先读被要求或与任务相关的 Skill，再运用其规则；接口没有给出的脚本或本地资源交给执行者处理。',
    '记忆：GET /api/roles/<roleId>/memory/recent 与 /memory/consolidated 查询索引；在各路径后追加 /<memoryId> 读取全文。POST /api/roles/<roleId>/memory/recent 新增，PATCH /api/roles/<roleId>/memory/recent/<memoryId> 更新近期记忆。新增正文示例：{"title":"已确认的决定","focus":"单一决定","content":"有证据的事实或偏好","keywords":["主题"],"source":{"kind":"agent","summary":"对应用户决定或执行回报"}}。',
    '已有沉淀记忆不直接 PATCH；需要修正时新增近期记忆说明来源与修正。POST /api/roles/<roleId>/memory/consolidation-requests 发起沉淀请求，取得 run 后交给其他 Agent 整理，按返回合同使用 /memory/consolidation-runs/<runId>/result 提交结果，不自己做整理。',
    '计划：GET /api/roles/<roleId>/plans 查询，追加 /<planId> 读取详情；同路径集合 POST 新建，单项 PATCH 更新、DELETE 删除（仅在确有删除授权时）。新建必须有 title、单行 focus、keywords 和有序 steps；例如 {"title":"完成目标","focus":"一个目标","status":"未开始","keywords":["主题"],"steps":[{"id":"investigate","title":"委派调查","status":"未开始"}],"source":{"kind":"agent","summary":"当前请求"}}。',
    'GET /api/roles/<roleId>/plan-statuses 和 /plan-marker-statuses 读取当前状态定义，不自造状态；taskBinding 绑定执行会话，secretaryBinding 绑定协调会话，字段为 agentType、sessionId、sessionTitle、workspace。计划 /<planId>/feedback 读取或提交引导/审批反馈，按 Manager 返回的当前合同与授权填写，不代替用户审批。',
    '新建计划、近期记忆、沉淀请求要在 requestHeadersJson 中传稳定 Idempotency-Key。更新计划/近期记忆、提交反馈/沉淀结果及版本化状态管理还须传上次权威 GET 的强 ETag If-Match。412 先读回；超时、503 或 uncertain 不自动重发，保留原键和正文查回执。',
    'rabiroute_agent_threads 的 requestJson 是请求对象的 JSON 字符串。发现：{"action":"list","agentAdapter":"dsh","query":"事项关键词","limit":20,"offset":0}，有 nextOffset 时分页。读取：{"action":"read","agentAdapter":"dsh","threadId":"完整目标ID"}；只能以实际返回内容为证，缺少业务结果时向目标索取正式回报。目标 adapter 按实际 owner 选择，不能失败后擅自改投其他客户端。',
    '创建和续投请求字段：action=create 或 send、agentAdapter=目标端、cwd=目标已配置工作区、prompt=交接正文；create 提供 title，send 提供 threadId。两者均提供 messageSource:{type:"agent",agentAdapter:"dsh",sessionId:"当前真实ID",sessionName:"真实当前名称"}、sourceThreadId:"同一当前ID"、sourceAgentType:"message_processing"、responsePolicy:"required"、responseInstruction:"请返回结果、证据、未完成项和下一步"。不能给自己派活；复用已有任务避免重复创建。',
    'GET /api/agent/requests/<requestId> 跟进回复，GET /api/message-processing/requirements/<requirementId> 读取消息需求，GET /api/message-processing/board 查询看板。正式回复仍用 threads/send，另填 inReplyToRequestId、result、nextAction；结束往返时 responsePolicy=none。',
    'rabiroute_agent_send 的 requestJson 包含 deliveryId、sender:{agentType:"message_processing",sessionId:"当前ID"}、routeId、channel、params 和 payload:{type:"text",text:"消息"}，实际身份与渠道以当前绑定/注入合同为准。回复已登记需求时携带 tracking.requirementId，先按 /api/message-processing/requirements/<id>/send-context 完成上下文核对取得凭证。群消息 params.replyToMessageId 使用真实来源 ID；明确主动无源发送才传空字符串。',
    '人格间消息使用 POST /api/personas/<targetPersonaId>/messages，bodyJson 包含 deliveryId、sourceRouteId、sourceCapability、text，可选 targetRouteId、conversationId、inReplyToMessageId、hopCount。sourceRouteId/sourceCapability 必须取当前 AgentPacket.replyContext 的 runtimeRouteId/personaMessagingCapability，缺少时不要伪造；目标有多个 Route 时明确选择。GET /api/personas/messages/receipts/<deliveryId> 查回执。渠道投递 GET /api/agent/send/receipts/<deliveryId> 查回执。只有真实回执才能报告已发送，最终文本不等于投递。',
    'Manager 不可用时报告连接失败，不切换到 Shell、文件或其他 API 作为替代。',
  ].join('\n')
}
