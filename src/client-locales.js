/** Locale-owned copy for the display-only Rabi message renderer. */
export const rabiClientLocales = {
  zh: {
    sender: '由 {name}（{adapter}）发送', raw: '查看原始消息内容', locate: '定位到Agent', more: '消息操作', close: '关闭',
    senderHint: '来源为消息自述，未经身份认证。点击定位到Agent。',
    external: '暂不支持定位此外部 Agent 处理端：{adapter}。未打开或创建任何会话。',
    unknown: '未找到可用的 DSH 会话：{id}。未按名称查找或创建替代会话。',
    unavailable: 'DSH 会话列表尚不可用，请稍后重试。',
    navigationFailed: '定位失败：{error}', copy: '复制消息', copied: '已复制', copyFailed: '复制失败，请重试。',
    extra: '其他消息内容', truncated: '内容已截断（共 {total} 个字符）',
    references: '引用：{labels}', separator: '、',
    // Folded-row copy for the two source kinds that carry no session identity.
    // `plan`/`system` are labelled by what they describe, and the source kind
    // itself is stated so a reader can tell them apart at a glance.
    fromSystem: '系统', fromPlan: '计划',
    eventTitle: '{name}', eventKind: '{type}',
    planTitle: '{name}（{id}）',
    fromAgent: '{name}（{adapter}）',
    expand: '展开内容', collapse: '收起内容',
  },
  en: {
    sender: 'Sent by {name} ({adapter})', raw: 'View original message', locate: 'Locate Agent', more: 'Message actions', close: 'Close',
    senderHint: 'The message claims this source; identity is not authenticated. Click to locate the Agent.',
    external: 'Navigation for this external Agent adapter is not supported: {adapter}. No session was opened or created.',
    unknown: 'No available DSH session with ID {id}. No name lookup or replacement session was created.',
    unavailable: 'The DSH session list is not available yet. Try again later.',
    navigationFailed: 'Navigation failed: {error}', copy: 'Copy message', copied: 'Copied', copyFailed: 'Copy failed. Please try again.',
    extra: 'Additional message content', truncated: 'Content truncated ({total} characters total)',
    references: 'References: {labels}', separator: ', ',
    fromSystem: 'System', fromPlan: 'Plan',
    eventTitle: '{name}', eventKind: '{type}',
    planTitle: '{name} ({id})',
    fromAgent: '{name} ({adapter})',
    expand: 'Show content', collapse: 'Hide content',
  },
}
