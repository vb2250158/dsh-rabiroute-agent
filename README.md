# dsh-rabiroute-agent

[English](README_en.md) | 简体中文

把 DSH 会话接入 RabiRoute 的受管任务、消息、计划和记忆接口。业务合同与 Codex 对齐，实际会话、工具和权限仍由 DSH 持有，不另启 Runtime、不改投 Codex。

> 连接优化已随 **0.1.5** 发布，并通过官方入口的隔离安装及只读连接验证。源码测试、正式环境安装、运行中工具、Hook 和真实业务投递分别验收，不能用隔离验证代替正式环境部署。

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
