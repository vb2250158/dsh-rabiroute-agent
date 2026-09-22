[English](PLAN-RESOURCES_en.md) | 简体中文

# 计划材料归档

用户在会话中发送的图片和文件使用 DSH 已持久化的附件引用归档。单个绑定计划自动接收；多个计划时，Agent 必须调用 `rabiroute_plan_resources` 的 `list` 和 `select`，为每组 `itemIds` 指定 `roleId`、`planId`。接口重新验证计划绑定当前 DSH 会话。用户原文不修改。

执行文件修改前，Agent 使用 `select` 指定 `stepId`。官方 `write`、`edit` 工具的成功结果自动记录路径、改动类型和内容摘要；Shell、外部编辑器及其他工具的改动由 Agent 调用 `record_changes` 提交实际修改的资源。记录保存在 Rabi 的 `steps[].resourceRecords`，区分 `tool-observed` 与 `agent-reported`，不会把整个工作区已有差异当作本次改动。Rabi Web 的步骤卡片显示“文件变动”。

后台归档使用强 ETag、稳定幂等键及写后回读。失败保留待发送记录；不确定结果只读回，不自动重放。归档不等待用户消息发送或模型上下文装配。多计划未选归属时，其他工具执行会被拦截，并要求先选择计划。新用户消息清除本轮选择。

`planResourcesEnabled` 默认开启。`planResourcesDirectory` 默认位于当前 DSH 数据目录的 `storages/rabiroute-plan-resources`；`planResourceRetryMs` 默认 30000；`planResourceTimeoutMs` 默认 12000；`planResourceMaxBytes` 默认 10485760。超过单文件限制的材料保留在 DSH，并显示待归档错误。队列中的 `pending` 清空才表示相关材料已确认保存。不要手工删除待发送队列。

需要支持步骤资源记录和分批追加附件的 Rabi 版本。旧服务拒绝或丢弃新字段时，插件保留待确认状态，不报告成功。原计划附件保留，新上传仍遵守单次最多 8 个、每文件 10 MiB、单次内容总量 25 MiB 的服务限制。
