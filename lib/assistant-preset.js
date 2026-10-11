/** Registered by the installed plugin; no machine-specific preset paths. */
export const rabiAssistantPreset = {
  id: 'rabi-assistant',
  name: 'Rabi助手模式',
  description: '沿用 Rabi 绑定的人格，可调用全部 Rabi 接口，保留联网搜索与网页读取。',
  order: 49,
  plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '按 Rabi 当前绑定的人格进行对话。', includeRuntimeContext: false } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { search: true, fetch: true, searchTimeoutMs: 60000 } },
    { id: 'rabi-assistant-mode', name: 'dsh-rabiroute-agent/assistant-mode' },
  ],
}
