/** Registered by the installed plugin; no machine-specific preset paths. */
export const rabiAssistantPreset = {
  id: 'rabi-assistant',
  name: 'Rabi助手模式',
  description: '沿用 Rabi 绑定的人格，只开放 Rabi 消息、会话、计划和记忆接口。',
  order: 49,
  plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '按 Rabi 当前绑定的人格进行对话。', includeRuntimeContext: false } },
    { id: 'rabi-assistant-mode', name: 'dsh-rabiroute-agent/assistant-mode' },
  ],
}
