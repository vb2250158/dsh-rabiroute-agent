# 自动语音输入 / Automatic voice input

提问卡自定义输入框下方的滑轨开关开启当前卡片的麦克风监听。静音、录音和转录阈值、自适应噪声门限、增益、前置缓冲、最短和最长语段均读取 Rabi `/api/speech/microphone/status`；DSH 不保存这些参数。监听期间每秒读取更新，参数改变时丢弃尚未完成的片段。

浏览器 PCM 按 Rabi 配置的 chunkMs 分块，执行 MicrophoneService 的 RMS、噪声估计和语段筛选规则。浏览器采集由 DSH 负责；转录仍交给 Rabi，并使用其麦克风配置的模型、语言和提示词。启用播放抑制时，Rabi 或当前页面正在播放音频会丢弃当前片段。DSH 不操作主机麦克风，不发起主机播放打断。

有效语段转录成功后写入官方受控输入框；Rabi `autoSubmit` 开启时通过官方 Enter 处理器继续或提交，关闭时只填入文字。每次成功识别后关闭开关。手动修改草稿、关闭开关、隐藏页面或移除输入框会取消监听和未完成的提交；权限请求迟到后仍会释放设备。识别错误不重试、不发送。音频沿现有 ASR 接口传输，仍受该接口 2 MiB 限制。

浏览器录音需要安全上下文（HTTPS 或本机 localhost）；局域网纯 HTTP 页面会明确显示不能录音。

The switch listens only for the current question. Live Rabi microphone settings own all segmentation and submission parameters. Valid speech fills the official draft and invokes its Enter handler only when Rabi autoSubmit is enabled. Success, cancellation, navigation or draft edits stop capture; errors never send or retry. The browser adapter does not control host microphone or host playback interruption.
