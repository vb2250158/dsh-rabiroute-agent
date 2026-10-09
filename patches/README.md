# 会话行标签补丁

适用基线：DSH 0.2.1-alpha.1，提交 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。补丁只增加通用的会话行标签、展示标题插槽和对应回归，不包含 Rabi 业务查询或工作区其它修改。

标签放在宿主状态图标与会话文字之间，运行和归档时保留。分组、平铺和搜索传入实际行身份。未注册标题增强时沿用原始标题；重命名使用存储名称。

升级宿主前保存原文件和本地差异，在宿主根执行：

```powershell
git apply --check <插件目录>/patches/session-row-labels.patch
git apply <插件目录>/patches/session-row-labels.patch
node node_modules/typescript/bin/tsc -b packages/client/ui-workspace/tsconfig.json
Push-Location packages/client/ui-workspace
node ../../../node_modules/tsdown/dist/run.mjs --env.DSH_BUILD_FACE client
Pop-Location
node <插件目录>/scripts/check-row-slots.mjs <宿主根>
```

已存在插槽时先运行检查，不重复应用。补丁冲突时停止套用，按当前宿主行组件迁移同一插槽；保留已有改动。检查失败时先补齐并构建接口，再安装插件和刷新页面。缺少接口不能用安装成功替代页面验收。

补丁随固定 Git 提交及 npm 包保存。官方仓库升级后重新检查源码与构建产物；页面验收需确认左侧文字标签、重复前缀隐藏、运行图标共存和搜索结果。
