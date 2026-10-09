# DSH 0.2 compatibility

This release requires DSH 0.2.1-alpha.1 or a compatible 0.2 release. The verified upstream revision is 5badb15009ae1756c3afe0ae0cef1faafc290ccc.

Declared DSH dependencies and browser injection packages match the current package inventory. Removed runtime and invariant packages are no longer declared.

Install the fixed commit reachable from the repository main branch through dsh plugin. The shared environment stores full commit ids; local source paths are not portable plugin pins.

The maintenance lockfile disables implicit peer installation and uses the current Cordis and schemastery versions. Git packages build without depending on the source checkout node_modules.

0.13.18 恢复常驻文字标签，需应用 [会话行插槽补丁](../patches/README.md)。补丁以当前 DSH 提交为基准，只扩展通用标签和展示标题插槽。升级前运行补丁检查；接口缺失时停止安装并补齐接口，避免标签静默消失。
