# dsh-rabiroute-agent

把 DSH Agent 接入 RabiRoute 的 Agent 线程和消息接口。

## 安装

锁定公开仓库的提交后，通过 DSH 官方入口安装：

```powershell
pnpm dsh plugin --profile web add github:vb2250158/dsh-rabiroute-agent#<commit>
```

插件包声明 `dsh.bundle`，安装后会把自己的配置层加入 profile。

## 配置

插件配置保存在 DSH profile 的 `cordis.patch.yml`。多电脑同步仓库只保存仓库地址、固定提交、启停状态和配置，不保存本仓库源码。

## 验证

```powershell
npm test
npm pack --dry-run
```

## 许可证

MIT
