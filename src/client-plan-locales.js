/** Locale-owned copy for the Rabi plan panel and its launcher. */
export const RABI_PLAN_NS = 'rabiroute-agent-plan'

export const rabiPlanLocales = {
  zh: {
    tab: 'Rabi 计划',
    directory: '计划目录', directoryCount: '计划目录（{count}）',
    launcherHint: '打开当前会话的 Rabi 计划面板',
    frameTitle: 'Rabi 计划面板',
    loading: '正在读取 Rabi 绑定…',
    reload: '重新加载', openExternal: '在浏览器打开',
    planUnbound: '当前会话没有 Rabi 人格绑定，也未在 Rabi 路由中找到绑定计划。',
    planNoPlan: '当前会话没有绑定中的 Rabi 计划。计划与 Agent 会话的绑定由 Rabi 决定，这里不会替你挑一个。',
    planNoRoute: '绑定的 Rabi 人格 {roleId} 没有对应的路由，无法定位计划页面。',
    planNoSession: '缺少会话标识，无法读取 Rabi 绑定。',
    planUnreachable: 'Rabi Manager 当前不可用：{error}',
    planUnreachableHint: '面板不会显示缓存或推断的计划；请确认 Rabi Manager 正在运行后重试。',
  },
  en: {
    tab: 'Rabi plan',
    directory: 'Plan directory', directoryCount: 'Plans ({count})',
    launcherHint: 'Open the Rabi plan panel for this session',
    frameTitle: 'Rabi plan panel',
    loading: 'Reading the Rabi binding…',
    reload: 'Reload', openExternal: 'Open in browser',
    planUnbound: 'This session has no Rabi persona binding or bound plan in the Rabi routes.',
    planNoPlan: 'No Rabi plan is bound to this session. Rabi owns that binding; this panel does not pick one for you.',
    planNoRoute: 'The bound Rabi persona {roleId} has no matching route, so its plan page cannot be located.',
    planNoSession: 'No session identity was supplied, so the Rabi binding cannot be read.',
    planUnreachable: 'Rabi Manager is unavailable: {error}',
    planUnreachableHint: 'The panel never shows a cached or inferred plan; start Rabi Manager and try again.',
  },
}
