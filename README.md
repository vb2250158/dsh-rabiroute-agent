# dsh-rabiroute-agent

[English](README_en.md) | 简体中文

把 DSH 会话接入 RabiRoute 的受管任务、消息、计划和记忆接口。业务合同与 Codex 对齐，实际会话、工具和权限仍由 DSH 持有，不另启 Runtime、不改投 Codex。

> 连接优化已随 **0.1.5** 发布，并通过官方入口的隔离安装及只读连接验证。源码测试、正式环境安装、运行中工具、Hook 和真实业务投递分别验收，不能用隔离验证代替正式环境部署。

## 定位与开发边界

本插件是 DSH 调用 Rabi 的工具适配层，不是 DSH 内的计划、记忆、人格或消息系统。工具可用不等于 Rabi 自动调度已启用，也不证明独立生命周期 Hook 已加载。

功能归属遵循 Rabi 的[统一 Agent 接入规范](https://github.com/vb2250158/RabiRoute/blob/main/docs/agent-adapter-standard-requirements.md)：能由 Rabi 统一实现的业务和策略放在 Rabi，供 DSH、Codex 及其他 Agent 复用。Rabi 暂时缺接口时优先补公共接口，不在 DSH 复制业务规则、状态库或调度器。

本插件只承担工具注册、请求与结果转换、连接校验和必要通信约束。必须进入 DSH 的内部事件、上下文注入、权限执行或 UI 才考虑宿主侧增强，并通过正式扩展点实现；Rabi 的业务决定不能扩大 DSH 本地权限。生命周期适配由独立 `rabi-dsh-context` Hook 负责，不在本插件重复实现。

新增需求必须说明：Rabi 为何无法直接完成、DSH 最小本地职责、业务真源、跨端共用合同、可选增强缺席时的行为及验收证据。公共能力不能要求 Codex 复制 DSH 界面，也不能把本插件的安装状态作为 Rabi 基础会话发现和投递的前提。能力说明分别标注工具接入、Hook 接入和实际业务验收，不把 API 名称当成 DSH 自有功能。

## 聊天消息展示增强（Unreleased，未安装验收）

目标是在聊天加载或历史消息重新渲染时识别开头的 `[消息源]` Agent 封套，在正文上方显示可点击的发送会话，并提供“查看原始消息内容”和“定位到Agent”菜单。识别仅用于显示，不改会话日志、模型输入、来源身份或回传参数；原文必须可查看。文本中的来源只是消息自述，不是经过认证的发送者证明，回传 JSON 不得自动执行。

解析源码位于 `src/message-envelope.js`，由浏览器构建打包；Host 工具入口不加载解析器。它只识别 Agent 来源，支持新旧字段名称及 LF/CRLF，保留原始字符串与正文空白；只拆出格式有效的末尾回传 JSON。重复字段、未知头字段、回传 JSON 歧义或投递 ID 冲突返回 `null`，调用方必须显示原文。其他来源类型及未知上下文块不作业务解释。

不符合支持格式或存在歧义时保留原样。来源会话按完整 ID 定位，不以名称猜测、不创建替代会话；外部 Agent 的解析与打开合同归 Rabi，不能把 Codex ID 当成本地 DSH ID。未知目标和未支持的宿主应明确提示。

浏览器源码通过公开 `conversation.chat.node` 插槽替换 `user` 和 `steering`，而不是装饰或调用官方 renderer；普通消息同样由本插件显示。正文复用公开 `projectUserText`，图片交回 owner 的图片呈现回调，文件、其他数据块、引用、时间与复制分别显示。复制保留完整原文；原文菜单使用 Modal。注册优先级为 -10，同一 key 的其他插件替换可能冲突，须核对当前组合。不接管 `context`、待提交回显或 Trajectory。

点击 DSH 来源会刷新会话目录，仅打开目录中完整 ID 精确匹配的会话；外部 Agent、不可用目录或未找到会话明确提示，不创建会话。跨端打开、未列入目录的子会话定位及原生界面逐像素一致性不在当前实现保证内。Client 源码和构建测试不替代实际安装后的浅色、深色、自定义主题、历史加载和键盘交互验收。

## 安装

通过「设置 → 我的插件」或 DSH 官方入口使用可获取的固定提交：

```powershell
pnpm dsh plugin --profile web add --save-exact github:vb2250158/dsh-rabiroute-agent#<commit>
```

使用本机实际 DSH Home 和 profile。包通过 `dsh.bundle` 注册配置层，不改官方源码。更新前保留配置与锁文件；未完成的插件/环境事务先走同步器受管恢复，不删除记录、不覆盖安装缓存、不用本地 link 代替正式安装。活动任务结束后通过既有受管入口重载，再核对真实加载版本及工具 schema。

## 配置

当前 profile 的 `cordis.patch.yml`：

```yaml
- id: rabiroute-agent
  config:
    managerBaseUrl: ""
    hostExecutable: ""
    enforceAgentCommunication: true
    requestTimeoutMs: 30000
```

机器专属值只保存在本机，不加入共享补丁。

- `managerBaseUrl` 留空：每项操作经 Host `status --json` 发现当前完整地址，核对 `/meta` 的健康、必需能力及非空 generation/实例身份，与 Host 一致才发业务请求。不缓存旧地址，不扫描端口。
- 非空 `managerBaseUrl`：显式开发/外部 Manager 的完整 HTTP(S) origin，不带路径、查询、片段或凭据；仍核对健康与身份，失败不换目标。源码模式可显式配置当前结构化 READY 地址。
- `hostExecutable`：可选本机 Host 可执行文件。留空时 Windows 根据 `LOCALAPPDATA` 派生常规安装位置；其它平台需显式配置 Host 或 Manager。只执行只读 status，不启停服务。
- `requestTimeoutMs`：整项操作预算，默认 30 秒，范围 1–120 秒。每次 HTTP 请求另限最多 12 秒，Host status 最多 3 秒，取消信号向下传播。
- `enforceAgentCommunication`：保留正式通信使用专用工具的约束。

注册插件不访问 Host，Manager 不可用不阻止 DSH 启动。`active=true` 仅说明工具已注册，不是业务健康证明。已有显式旧地址需清空才能选择 Host 模式，不会偷偷忽略显式目标。

## 工具合同

- `rabiroute_agent_threads`：通过 Manager 查找、读取、解析、创建、改名、续投及正式回复。保留完整任务身份和原绑定；来源与 `sourceThreadId` 不一致时拒绝。旧 `deliverySource` 输入仅在边界归一化，发送字段始终是 `messageSource`。回复策略和正式回复字段遵守当前 Manager 合同。
- `rabiroute_agent_send`：明确外发，保留 `deliveryId`、发送者及渠道回执。HTTP 成功不代替真实渠道送达。
- `rabiroute_manager_api`：允许路径内的计划、记忆、消息处理和回复请求；额外开放精确 `GET /meta`、`GET /api/agent/send/receipts/:id`、`GET /api/agent/send/traces`。健康和回执仅 GET，拒绝路径穿越、编码分隔符与跨 origin 重定向。

通用工具支持 `GET/POST/PUT/PATCH/DELETE`。可选 `requestHeadersJson` 仅允许 `If-Match` 和 `Idempotency-Key`。例如：

```json
{
  "method": "PATCH",
  "path": "/api/roles/example-role/plans/example-plan",
  "bodyJson": "{\"currentStep\":\"已按实际证据更新\"}",
  "requestHeadersJson": "{\"If-Match\":\"\\\"revision-from-get\\\"\",\"Idempotency-Key\":\"stable-operation-id\"}"
}
```

此例不是执行授权。写入前读取现行接口文档、状态目录、资源与强 ETag。

- 新建计划、近期记忆、发起整理需要稳定键；更新计划/近期记忆、反馈、整理结果及版本化状态目录还需要强 ETag `If-Match`。不对所有 API 一刀切，业务规则仍由 Manager 判定。
- 输出保留 HTTP 状态、正文字符串、允许的响应头、ETag、身份及 `uncertain/error`，渲染不隐藏这些字段。成功仍须核对回显键、强 ETag、资源身份并读回，插件不自动完成语义验收。
- 写入不自动重放。超时、503、网络失败或写后身份变化保留不确定状态及已有响应，保持原键原正文先读回。412 重新读后确认原意，再用新键与新 ETag。
- 仅 GET 操作的业务请求发送前发现失败允许一次重新发现；业务 GET 也不重放，因为读取近期记忆可能刷新 `viewedAt`。健康探针仅用 `/meta`。

## Hook 与 Codex 边界

对齐现行 Manager 合同，不照搬旧 Codex 客户端缺失的身份/响应头校验。`rabi-dsh-context` 是独立生命周期 Hook；本插件不复制人格、记忆、Hook 决策，也不证明 SessionStart、权限检查、Stop 或真实投递已验证。Hook 与工具连接配置须分别核对，不用另一条路径掩盖故障。

## 验证与排障

```powershell
npm test
npm run build
npm pack --dry-run
```

构建同步 `src/index.js`、`src/connection.js` 到实际包入口 `lib`。测试检查产物一致、换代、身份拒绝、响应头、412/503、不重放、来源冲突、路径隔离和取消。发布前检查安装包没有用户配置、凭据、业务记录或私有标识。

最小真实验收：用新包工具定义执行 `GET /meta`，核对 Host 身份；安装重载后用会话内正式工具复验。前者不能代替后者，更不证明业务写入或 Hook 正常。

旧版 `fetch failed` 先比较工具配置与 Host 当前地址。旧端口失败不代表 Manager 已挂，不要把今天的动态端口写成新固定默认值。

## 许可证

MIT
