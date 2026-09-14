# AGENTS.md

- 本仓库只保存 dsh-rabiroute-agent 的公开源码、构建产物、测试和文档。
- 用户配置、安装清单、凭据、日志和业务数据不得提交。
- 插件通过 `dsh.bundle` 和 `cordis.patch.yml` 接入 DSH，不修改官方源码。
- 功能归属先读 [README 的开发边界](README.md#定位与开发边界)及其链接的 Rabi 统一规范：能在 Rabi 统一实现的业务与策略放在 Rabi，供 DSH、Codex 等端复用；本插件只做必要工具适配，宿主增强须说明 Rabi 无法直接完成的具体缺口，不因缺接口复制业务真源或调度。
- 发布前运行测试、构建（若有）和 `npm pack --dry-run`，并检查安装包不含私有数据。
