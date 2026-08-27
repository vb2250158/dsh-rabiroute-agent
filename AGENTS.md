# AGENTS.md

- 本仓库只保存 dsh-rabiroute-agent 的公开源码、构建产物、测试和文档。
- 用户配置、安装清单、凭据、日志和业务数据不得提交。
- 插件通过 `dsh.bundle` 和 `cordis.patch.yml` 接入 DSH，不修改官方源码。
- 发布前运行测试、构建（若有）和 `npm pack --dry-run`，并检查安装包不含私有数据。
