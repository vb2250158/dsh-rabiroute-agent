window.__ModuleLoader__.load({
  id: 'dsh-rabiroute-agent',
  factory: (require) => {
    const React = require('react')
    const { Button, Menu, Modal, JsonBlock, projectUserText, fileSizeText, writeClipboard } = require('@deepseek-ai/dsh-client-ui-primitives')
/** Pure historical Rabi-envelope projection; no runtime or UI registration. */
const fields = new Map([
  ['类型', 'type'], ['消息源类型', 'type'],
  ['处理端', 'agentAdapter'], ['Agent 端', 'agentAdapter'],
  ['角色', 'agentType'], ['会话', 'sessionName'], ['会话名称', 'sessionName'],
  ['会话 ID', 'sessionId'], ['工作目录', 'workspace'],
  ['投递时间', 'sentAt'], ['消息包发送时间', 'sentAt'], ['投递 ID', 'deliveryId'],
  ['计划名称', 'planName'], ['计划 ID', 'planId'],
  ['事件类型', 'eventType'], ['事件名称', 'eventName'], ['事件 ID', 'eventId'],
  ['触发方类型', 'actorType'], ['触发方名称', 'actorName'], ['触发方 ID', 'actorId'],
  ['消息路线', 'routeName'], ['消息路线 ID', 'routeId'],
  ['消息端', 'messageAdapter'],
  ['会话类型', 'conversationType'], ['发送者名称', 'senderName'], ['发送者 ID', 'senderId'],
  ['消息 ID', 'messageId'], ['消息组 ID', 'messageGroupId'],
])
// The source kinds the producer declares. `agent` keeps the historical `Agent`
// spelling, and is the only kind that is case-sensitive: a lowercase `agent` is
// not a value any producer writes, so it stays on the conservative fallback.
// `plan` and `system` never carried a session identity of their own, so their
// required fields are declared per kind.
const sourceKinds = new Map([
  ['Agent', { kind: 'agent', required: ['agentAdapter', 'sessionName', 'sessionId', 'sentAt'] }],
  ['计划', { kind: 'plan', required: ['planName', 'planId', 'sentAt'] }],
  ['系统', { kind: 'system', required: ['eventType', 'eventName', 'eventId', 'sentAt'] }],
])
const unsafeMetadata = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u
const trimSpaces = value => value.replace(/^ +| +$/g, '')
const nonemptyMetadata = value => typeof value === 'string' && Boolean(value.trim()) && !unsafeMetadata.test(value)

// JSON.parse accepts duplicate keys. Reject them at every object depth rather than
// concealing conflicting display data behind JSON's last-key-wins behavior.
function hasDuplicateKeys(json) {
  const stack = []
  const tokens = json.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/gs) || []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '{') stack.push(new Set())
    else if (token === '[') stack.push(null)
    else if (token === '}' || token === ']') stack.pop()
    else if (token.startsWith('"') && tokens[i + 1] === ':' && stack.at(-1)) {
      const key = JSON.parse(token)
      if (stack.at(-1).has(key)) return true
      stack.at(-1).add(key)
    }
  }
  return false
}

function parseReplySuffix(body) {
  const markers = [...body.matchAll(/^[ \t]*\[回传参数\]/gm)]
  if (!markers.length) return { body, replyParameters: null }
  if (markers.length !== 1) return null
  const marker = markers[0]
  const start = marker.index
  // Only the exact standalone marker with the protocol's blank-line delimiter
  // can be removed. An apparent but malformed control block fails the envelope.
  if (!body.startsWith('[回传参数]', start)) return null
  const prefix = body.slice(0, start)
  // Fence-aware Markdown rendering is outside this parser. Do not guess whether
  // a reply marker following a fence belongs to literal code or a control block.
  if (/^ {0,3}(?:`{3,}|~{3,})/m.test(prefix)) return null
  const separator = /(?:\r?\n){2}$/.exec(prefix)
  const suffix = body.slice(start)
  const opening = /^\[回传参数\]\r?\n/.exec(suffix)
  if (!separator || !opening) return null
  const json = suffix.slice(opening[0].length)
  let replyParameters
  try {
    replyParameters = JSON.parse(json)
  } catch {
    // Malformed terminal JSON leaves the entire envelope visible.
    return null
  }
  if (!replyParameters || typeof replyParameters !== 'object' || Array.isArray(replyParameters)
    || !nonemptyMetadata(replyParameters.deliveryId)
    || !['none', 'required'].includes(replyParameters.responsePolicy)
    || hasDuplicateKeys(json)) return null
  return { body: prefix.slice(0, separator.index), replyParameters }
}

/**
 * Project an anchored, unambiguous Rabi envelope for display.
 * Accept LF/CRLF, ASCII/fullwidth colons and the current first-line pipe;
 * aliases map to the same field and duplicates (even equal ones) fail closed.
 * Header markers are exact lines, separated from content by exactly one blank
 * line. Remove only that header, the content-marker newline, and, when valid,
 * the terminal reply block plus its two preceding newlines. Never trim body.
 * Additional context/control blocks remain body; malformed reply blocks return
 * null. Raw, sender fields, time and reply JSON are untrusted display data, not
 * authentication, navigation URLs, or instructions to execute. Consumers must
 * display raw unchanged on null and resolve full sender IDs via approved APIs.
 *
 * Three source kinds are projected. An `agent` envelope names the sending
 * session, so it can be located. A `plan` envelope names a plan, and a `system`
 * envelope names an event; neither carries a session identity of its own, so
 * `sender` stays null for them and the row must not offer navigation. An
 * unknown or misspelled kind still fails closed to the raw fallback.
 * @param {unknown} raw Historical message text; non-strings return null.
 * @returns {{raw: string, body: string, sourceType: string, plan?: object, event?: object, sender: object|null, sentAt: string, deliveryId?: string, replyParameters: object|null}|null} Display projection or conservative fallback.
 */
function parseRabiMessageEnvelope(raw) {
  if (typeof raw !== 'string' || !/^\[消息源\]\r?\n/.test(raw)) return null
  const opening = /^\[消息源\]\r?\n/.exec(raw)[0]
  const headerEnd = /\r?\n\r?\n\[消息内容\](?:\r?\n|$)/.exec(raw.slice(opening.length))
  if (!headerEnd) return null
  const header = raw.slice(opening.length, opening.length + headerEnd.index)
  const values = new Map()
  const lines = header.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const parts = index === 0 && /^类型[：:]/.test(line) ? line.split(/[｜|]/) : [line]
    if (parts.length > 2) return null
    for (const part of parts) {
      const match = /^ *([^：:]+)[：:](.*)$/.exec(part)
      if (!match) return null
      const key = fields.get(trimSpaces(match[1]))
      const value = trimSpaces(match[2])
      if (!key || values.has(key) || !nonemptyMetadata(value)) return null
      values.set(key, value)
    }
  }
  const declared = sourceKinds.get(values.get('type'))
  if (!declared || !declared.required.every(key => values.has(key))) return null
  // Each kind owns a disjoint field set. A header mixing them (say a plan name
  // on a system envelope) is not a shape any producer writes, so it fails
  // closed rather than letting the renderer pick a label from ambiguous data.
  // `plan` additionally permits the source agent identity, because the producer
  // appends it to a plan envelope when one exists.
  const agentFields = ['agentAdapter', 'agentType', 'sessionName', 'sessionId', 'workspace']
  const allowed = declared.kind === 'agent' ? [...agentFields, 'sentAt', 'deliveryId']
    : declared.kind === 'plan' ? ['planName', 'planId', ...agentFields, 'sentAt', 'deliveryId']
      : ['eventType', 'eventName', 'eventId', 'actorType', 'actorName', 'actorId', 'routeName', 'routeId', 'sentAt', 'deliveryId']
  if ([...values.keys()].some(key => key !== 'type' && !allowed.includes(key))) return null
  // The producer writes no such thing as half an agent identity: `agentAdapter`
  // without a session (or the reverse) is a malformed record, not a partial one.
  // `agentType`/`workspace` stay independent optionals on every kind.
  const hasAnyIdentity = agentFields.some(key => values.has(key))
  if (hasAnyIdentity && !['agentAdapter', 'sessionName', 'sessionId'].every(key => values.has(key))) return null
  const content = raw.slice(opening.length + headerEnd.index + headerEnd[0].length)
  const parsed = parseReplySuffix(content)
  if (!parsed) return null
  const deliveryId = values.get('deliveryId')
  if (deliveryId && parsed.replyParameters && deliveryId !== parsed.replyParameters.deliveryId) return null
  const sentAt = values.get('sentAt')
  const identity = () => {
    const agent = { type: 'agent', agentAdapter: values.get('agentAdapter'), sessionName: values.get('sessionName'), sessionId: values.get('sessionId') }
    for (const key of ['agentType', 'workspace']) if (values.has(key)) agent[key] = values.get(key)
    return agent
  }
  const shared = { raw, ...parsed, sourceType: declared.kind, sentAt, ...(deliveryId ? { deliveryId } : {}) }
  if (declared.kind === 'agent') return { ...shared, sender: identity() }
  if (declared.kind === 'plan') {
    const plan = { planName: values.get('planName'), planId: values.get('planId') }
    if (hasAnyIdentity) plan.sourceAgent = identity()
    return { ...shared, plan, sender: null }
  }
  const event = { eventType: values.get('eventType'), eventName: values.get('eventName'), eventId: values.get('eventId') }
  for (const key of ['actorType', 'actorName', 'actorId', 'routeName', 'routeId']) if (values.has(key)) event[key] = values.get(key)
  return { ...shared, event, sender: null }
}

/** Locale-owned copy for the display-only Rabi message renderer. */
const rabiClientLocales = {
  zh: {
    sender: '由 {name}（{adapter}）发送', raw: '查看原始消息内容', locate: '定位到Agent', more: '消息操作', close: '关闭',
    senderHint: '来源为消息自述，未经身份认证。点击定位到Agent：DSH 会话直接切换，其它处理端交给 RabiRoute 唤起对应窗口。',
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
    senderHint: 'The message claims this source; identity is not authenticated. Click to locate the Agent: a DSH session is selected in place, any other adapter is handed to RabiRoute to raise that client window.',
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

/** Locale-owned copy for the Rabi plan panel and its launcher. */
const RABI_PLAN_NS = 'rabiroute-agent-plan'

const rabiPlanLocales = {
  zh: {
    tab: 'Rabi 计划',
    launcherHint: '打开 Rabi 计划面板（当前会话已绑定 Rabi 人格）',
    frameTitle: 'Rabi 计划面板',
    loading: '正在读取 Rabi 绑定…',
    reload: '重新加载', openExternal: '在浏览器打开',
    planUnbound: '当前会话尚未绑定 Rabi 人格，没有可显示的计划。',
    planNoPlan: '当前会话没有绑定中的 Rabi 计划。计划与 Agent 会话的绑定由 Rabi 决定，这里不会替你挑一个。',
    planMultiplePlans: '当前会话绑定了 {count} 个计划（{titles}）。Rabi 要求先收敛为一个计划再打开面板。',
    planNoRoute: '绑定的 Rabi 人格 {roleId} 没有对应的路由，无法定位计划页面。',
    planNoSession: '缺少会话标识，无法读取 Rabi 绑定。',
    planUnreachable: 'Rabi Manager 当前不可用：{error}',
    planUnreachableHint: '面板不会显示缓存或推断的计划；请确认 Rabi Manager 正在运行后重试。',
  },
  en: {
    tab: 'Rabi plan',
    launcherHint: 'Open the Rabi plan panel (this session is bound to a Rabi persona)',
    frameTitle: 'Rabi plan panel',
    loading: 'Reading the Rabi binding…',
    reload: 'Reload', openExternal: 'Open in browser',
    planUnbound: 'This session is not bound to a Rabi persona, so there is no plan to show.',
    planNoPlan: 'No Rabi plan is bound to this session. Rabi owns that binding; this panel does not pick one for you.',
    planMultiplePlans: 'This session is bound to {count} plans ({titles}). Rabi requires that to settle to one plan before the panel can open.',
    planNoRoute: 'The bound Rabi persona {roleId} has no matching route, so its plan page cannot be located.',
    planNoSession: 'No session identity was supplied, so the Rabi binding cannot be read.',
    planUnreachable: 'Rabi Manager is unavailable: {error}',
    planUnreachableHint: 'The panel never shows a cached or inferred plan; start Rabi Manager and try again.',
  },
}

/** Local geometry uses the active theme's semantic color tokens. */
const rabiClientStyles = {
  row: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', minWidth: 0 },
  stack: { display: 'grid', gap: '8px', maxWidth: '100%', minWidth: 0 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', minWidth: 0 },
  sender: { maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'start', height: 'auto', minHeight: '28px' },
  bubble: { padding: '10px 14px', borderRadius: '16px', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0 },
  attachments: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '8px', minWidth: 0 },
  file: { display: 'grid', gap: '4px', padding: '8px 12px', border: '1px solid var(--dsw-alias-line-primary)', borderRadius: '10px', maxWidth: '100%', overflowWrap: 'anywhere' },
  muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', overflowWrap: 'anywhere' },
  actions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' },
  raw: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '65vh', overflow: 'auto', color: 'var(--dsw-alias-label-primary)' },
  planFrameBox: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  // The frame fills the panel when the panel has a height, and never collapses to a
  // sliver when it does not: Rabi's own page needs a usable viewport either way.
  planFrame: { flex: '1 1 auto', width: '100%', minHeight: '70vh', border: 'none', background: 'var(--dsw-alias-bg-layer-1)' },
  planNotice: { display: 'grid', gap: '8px', padding: '12px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', overflowWrap: 'anywhere' },
  planActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  // The header entry is Rabi's own mark, so it drops the button's text padding for the
  // 28x28 icon form the primitives keep for icon-only controls.
  planLauncherButton: { padding: 0, width: '28px' },
  planLauncherIcon: { display: 'block', width: '16px', height: '16px', borderRadius: '3px' },
}

/**
 * Rabi's own brand icon, small enough to travel with the launcher.
 *
 * Generated from RabiRoute's assets/rabiroute-icon.png (see the sibling note in
 * the plugin README). Embedded rather than fetched: the DSH client has no
 * dependable URL for Rabi's web assets, and a runtime fetch would blink empty.
 */

/** The icon as a PNG data URI, usable directly as an <img> source. */
const RABI_PLAN_ICON_DATA_URI =
  'data:image/png;base64,'
  + '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'
  + 'z/E/38tkbgRdxDEAAAAASUVORK5CYII='

/** Client half: the Rabi plan panel, drawn by Rabi's own WebGUI inside the right Sidebar. */

/**
 * The plan panel is a thin frame, never a second plan renderer.
 *
 * Which plan a session is bound to, what that plan contains and how it looks all stay
 * Rabi's business: this module asks the Host's same-origin route which single plan the
 * session is bound to, then frames Rabi's own view of that plan. Nothing here reads a
 * plan, caches one, or draws one — a missing binding, an unresolved binding or an
 * unreachable Manager is reported as such rather than filled in from local state.
 */

/** The tab type's kind, and the id its body registers under. */
const RABI_PLAN_KIND = 'rabi-plan'
const RABI_PLAN_TAB_ID = 'dsh-rabiroute-agent/plan'
/** The Host route answering the binding question; same origin, so no CORS policy is needed. */
const RABI_PLAN_PANEL_PATH = '/rabiroute/plan-panel'

/**
 * Sessions whose panel was already auto-opened once. Auto-opening is a courtesy
 * for a session the user just entered; repeating it on every switch back would
 * keep re-opening a column the user closed on purpose.
 */
const rabiPlanAutoOpened = new Set()

/**
 * Ask the Host which Rabi route this session's binding resolves to.
 * @param sessionId - the DSH session whose Rabi binding decides the target.
 * @param signal - aborts the read when the panel leaves the screen.
 * @returns the Host's panel state; a failure is reported, never thrown away.
 */
async function readRabiPlanPanelState(sessionId, signal) {
  const url = RABI_PLAN_PANEL_PATH + '?sessionId=' + encodeURIComponent(String(sessionId || ''))
  const response = await fetch(url, { signal, cache: 'no-store', headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const payload = await response.json()
  const data = payload?.data
  if (!data || typeof data !== 'object') throw new Error('The panel route returned no state.')
  return data
}

/**
 * The tab type's registry definition: a page type, opened by kind.
 *
 * It deliberately contributes no guide entry: a guide entry would take the
 * Sidebar's default page from the shipped Files page to the guide for every
 * session, including unbound ones. The entry lives on the session header and in
 * the binding-driven open instead, so nothing changes outside Rabi-bound sessions.
 * @param t - copy bound to this plugin's plan namespace.
 * @returns the definition to register.
 */
function rabiPlanTabDefinition(t) {
  return {
    id: RABI_PLAN_TAB_ID,
    kind: RABI_PLAN_KIND,
    title: () => t('tab'),
  }
}

/** The sentence explaining an empty panel; each reason names its own cause. */
function rabiPlanEmptyText(data, t) {
  if (data?.reason === 'unbound') return t('planUnbound')
  if (data?.reason === 'no-plan') return t('planNoPlan')
  // More than one bound plan is Rabi's own error state; the panel reports it rather
  // than choosing one, and names them so the fix is obvious.
  if (data?.reason === 'multiple-plans') return t('planMultiplePlans', {
    count: String(data.planCount ?? ''),
    titles: (Array.isArray(data.planTitles) ? data.planTitles : []).join(' / '),
  })
  if (data?.reason === 'unrouted') return t('planNoRoute', { roleId: String(data.roleId || '') })
  if (data?.reason === 'no-session') return t('planNoSession')
  return t('planUnreachable', { error: String(data?.message || data?.reason || 'unknown') })
}

/**
 * The tab body: Rabi's plan page for this session's bound persona, in a frame.
 * @param props - framework props carrying the session identity and plan copy.
 */
function RabiPlanBody({ sessionId, t }) {
  const [state, setState] = React.useState({ phase: 'loading' })
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    const controller = new AbortController()
    let active = true
    setState({ phase: 'loading' })
    readRabiPlanPanelState(sessionId, controller.signal)
      .then(data => {
        if (!active) return
        setState({ phase: data.available ? 'ready' : 'empty', data })
      })
      .catch(error => {
        if (!active) return
        setState({ phase: 'empty', data: { available: false, reason: 'unreachable', message: error instanceof Error ? error.message : String(error) } })
      })
    return () => { active = false; controller.abort() }
  }, [sessionId, attempt])

  const reload = React.useCallback(() => { setAttempt(value => value + 1) }, [])

  if (state.phase === 'loading') {
    return React.createElement('div', { style: rabiClientStyles.planNotice }, t('loading'))
  }
  if (state.phase === 'ready') {
    return React.createElement('div', { style: rabiClientStyles.planFrameBox },
      React.createElement('iframe', { key: state.data.url, src: state.data.url, title: t('frameTitle'), style: rabiClientStyles.planFrame }))
  }
  return React.createElement('div', { style: rabiClientStyles.planNotice },
    React.createElement('div', null, rabiPlanEmptyText(state.data, t)),
    // The hint repeats the rule the panel obeys: no cached plan is ever shown in Rabi's place.
    React.createElement('div', { style: rabiClientStyles.muted }, t('planUnreachableHint')),
    React.createElement('div', { style: rabiClientStyles.planActions },
      React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: reload }, t('reload')),
      state.data?.url ? React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: () => { try { window.open(state.data.url, '_blank', 'noopener') } catch { /* a blocked popup is not an error worth reporting */ } } }, t('openExternal')) : null))
}

/**
 * The session-header entry: shown while the session is bound to a Rabi persona, and it
 * opens the panel the first time that binding is seen.
 *
 * Visibility turns on the **binding**, not on a plan already existing. Gating it on
 * availability hid the entry in exactly the case it was asked for, because a bound
 * session whose plan has not been recorded yet is the normal state between "Rabi bound
 * this session" and "Rabi attached a plan"; the panel is where that gets explained.
 * Auto-opening still requires a plan, so a bound-but-empty session does not open a
 * column that has nothing to show.
 * @param props - framework props plus the panel-opening callback from `inject`.
 */
function RabiPlanLauncher({ sessionId, t, openRabiPlanTab }) {
  const [state, setState] = React.useState({ phase: 'hidden' })
  // The callback is held in a ref so a re-created inject face cannot re-run the read.
  const open = React.useRef(openRabiPlanTab)
  open.current = openRabiPlanTab
  React.useEffect(() => {
    const controller = new AbortController()
    let active = true
    readRabiPlanPanelState(sessionId, controller.signal)
      .then(data => {
        if (!active) return
        // A roleId is what "this session is bound to a Rabi persona" looks like from here.
        if (!data.roleId) return
        setState({ phase: 'ready' })
        if (!data.available || rabiPlanAutoOpened.has(sessionId)) return
        try {
          open.current()
          // Only a successful open counts: a column that was not mounted yet must
          // stay eligible, so the next render can still open it.
          rabiPlanAutoOpened.add(sessionId)
        } catch {
          // Opening can refuse while the session's panel is not mounted; the
          // button remains, so the user can open it deliberately.
        }
      })
      .catch(() => { if (active) setState({ phase: 'hidden' }) })
    return () => { active = false; controller.abort() }
  }, [sessionId])

  if (state.phase !== 'ready') return null
  // Rabi's own mark, carried in the bundle: the entry is the way back to a panel the
  // user closed, so it has to be recognisable at a glance and must not depend on a
  // fetch that could fail or flash.
  return React.createElement(Button, {
    size: 'sm', variant: 'ghost', style: rabiClientStyles.planLauncherButton,
    icon: React.createElement('img', {
      src: RABI_PLAN_ICON_DATA_URI, alt: '', width: 16, height: 16,
      style: rabiClientStyles.planLauncherIcon,
    }),
    'aria-label': t('launcherHint'), title: t('launcherHint'),
    onClick: () => { try { open.current() } catch { /* the sidebar reports its own refusal */ } },
  })
}


const rabiSpeechLocales = {
  zh: { play: '朗读回复', busy: '生成中', pause: '暂停', resume: '播放', seek: '播放进度', failed: '生成失败，请重试', offline: 'Rabi TTS 服务未开启', 'no-default': 'Rabi 未配置默认 TTS', 'bad-request': '回复为空或超过 10000 字符', unreachable: '无法连接 Rabi', rejected: 'Rabi 拒绝了生成请求', playback: '无法播放音频，请重试播放', upgrade: '请重启 DSH 以加载新版语音服务' },
  en: { play: 'Read reply aloud', busy: 'Generating', pause: 'Pause', resume: 'Play', seek: 'Playback position', failed: 'Generation failed. Retry.', offline: 'Rabi TTS is offline', 'no-default': 'No default TTS configured in Rabi', 'bad-request': 'Reply is empty or exceeds 10000 characters', unreachable: 'Cannot connect to Rabi', rejected: 'Rabi rejected synthesis', playback: 'Unable to play audio. Try playing again.', upgrade: 'Restart DSH to load the updated speech service' },
}

/** Extract only the clicked reply body, never reasoning or tool calls. */
function rabiReplyText(snapshot, messageId) {
  const node = snapshot.eventNodes.find(node => node.kind === 'assistant' && node.messageId === messageId)
  return node?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n\n') || ''
}

function speechTime(seconds) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

/** Compact browser player; synthesis and voice defaults remain owned by Rabi. */
function RabiSpeechAction({ sessionId, messageId, useTrajectory, t }) {
  const text = useTrajectory(snapshot => rabiReplyText(snapshot, messageId))
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState(null)
  const [ready, setReady] = React.useState(false)
  const [playing, setPlaying] = React.useState(false)
  const [position, setPosition] = React.useState(0)
  const [duration, setDuration] = React.useState(0)
  const pending = React.useRef(null)
  const media = React.useRef(null)
  const releaseAudio = () => {
    const current = media.current
    if (!current) return
    media.current = null
    current.audio.onloadedmetadata = current.audio.ondurationchange = current.audio.ontimeupdate = current.audio.onplay = current.audio.onpause = current.audio.onended = current.audio.onerror = null
    current.audio.pause()
    current.audio.removeAttribute('src')
    current.audio.load()
    URL.revokeObjectURL(current.url)
  }
  React.useEffect(() => {
    setBusy(false); setNotice(null); setReady(false); setPlaying(false); setPosition(0); setDuration(0)
    return () => { pending.current?.abort(); pending.current = null; releaseAudio() }
  }, [sessionId, messageId])
  const startAudio = async current => {
    try { await current.audio.play() } catch {
      if (media.current === current) { setPlaying(false); setNotice(t('playback')) }
    }
  }
  const play = async () => {
    if (pending.current) return
    if (media.current) {
      setNotice(null)
      if (!media.current.audio.paused) media.current.audio.pause()
      else await startAudio(media.current)
      return
    }
    const controller = new AbortController()
    pending.current = controller
    setBusy(true); setNotice(null)
    try {
      const response = await fetch('/rabiroute/speech', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, sessionId }) })
      if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/wav')) {
        const result = await response.json()
        throw new Error(result.ok ? t('upgrade') : `${t(result.reason in rabiSpeechLocales.en ? result.reason : 'failed')}${result.message ? `: ${result.message}` : ''}`)
      }
      const blob = await response.blob()
      if (pending.current !== controller) return
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      const current = { audio, url }
      media.current = current
      const update = () => {
        if (media.current !== current) return
        setPosition(audio.currentTime)
        setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
        setPlaying(!audio.paused && !audio.ended)
      }
      audio.onloadedmetadata = audio.ondurationchange = audio.ontimeupdate = audio.onplay = audio.onpause = audio.onended = update
      audio.onerror = () => {
        if (media.current !== current) return
        releaseAudio(); setReady(false); setPlaying(false); setNotice(t('playback'))
      }
      setReady(true)
      await startAudio(current)
    } catch (error) {
      if (pending.current === controller) setNotice(error instanceof Error ? error.message : t('failed'))
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }
  if (!text.trim()) return null
  const label = busy ? 'busy' : ready ? playing ? 'pause' : 'resume' : 'play'
  const path = ready ? playing ? 'M8 5v14 M16 5v14' : 'm8 5 11 7-11 7V5Z' : 'M11 5 6 9H3v6h3l5 4V5Z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14'
  return React.createElement('span', { 'data-rabi-speech': true, style: { display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, verticalAlign: 'middle', fontSize: 11 } },
    React.createElement(Button, { size: 'sm', variant: 'ghost', disabled: busy, title: t(label), 'aria-label': t(label), 'aria-busy': busy, onClick: play, style: { height: 24, width: 24, minHeight: 24, padding: 3 } },
      React.createElement('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, React.createElement('path', { d: path }))),
    busy && React.createElement('span', { role: 'status', style: { display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' } }, t('busy'), React.createElement('progress', { 'aria-label': t('busy'), style: { width: 44, height: 4 } })),
    ready && !busy && React.createElement('input', { type: 'range', min: 0, max: duration || 1, step: 0.1, value: position, disabled: !duration, 'aria-label': t('seek'), 'aria-valuetext': `${speechTime(position)} / ${speechTime(duration)}`, style: { width: 84, height: 16, margin: 0, accentColor: 'currentColor', cursor: 'pointer' }, onChange: event => {
      if (!media.current || !duration) return
      const next = Math.min(duration, Math.max(0, Number(event.target.value)))
      media.current.audio.currentTime = next; setPosition(next)
    } }),
    ready && !busy && React.createElement('span', { style: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, `${speechTime(position)}/${speechTime(duration)}`),
    notice && React.createElement('span', { role: 'alert', title: notice, 'aria-label': notice, style: { cursor: 'help' } }, '⚠'))
}


const rabiQuestionLocales = {
  zh: {
    branch: '自己的分支',
    record: '语音输入',
    stop: '停止录音',
    busy: '识别中',
    denied: '没有麦克风权限',
    empty: '没有识别到内容',
    offline: 'Rabi ASR 服务未开启',
    'no-default': 'Rabi 未配置默认 ASR',
    'bad-request': '录音无效或过长',
    unreachable: '无法连接 Rabi',
    rejected: 'Rabi 拒绝了识别请求',
    failed: '识别失败，请重试',
    unsupported: '当前浏览器不能录音',
  },
  en: {
    branch: 'Your own branch',
    record: 'Voice input',
    stop: 'Stop recording',
    busy: 'Transcribing',
    denied: 'Microphone permission denied',
    empty: 'Nothing was recognized',
    offline: 'Rabi ASR is offline',
    'no-default': 'No default ASR configured in Rabi',
    'bad-request': 'Recording is empty or too large',
    unreachable: 'Cannot connect to Rabi',
    rejected: 'Rabi rejected transcription',
    failed: 'Transcription failed. Retry.',
    unsupported: 'This browser cannot record audio',
  },
}

function encodePcmWav(float32, sampleRate) {
  const rate = Math.floor(Number(sampleRate) || 0)
  if (!float32 || !Number.isInteger(float32.length) || rate < 8000 || rate > 48000) return null
  const pcm = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i] || 0))
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  const bytes = pcm.length * 2
  const buffer = new ArrayBuffer(44 + bytes)
  const view = new DataView(buffer)
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)) }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, bytes, true)
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer))
  return new Uint8Array(buffer)
}

function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Write into the official controlled textarea without replacing the composer. */
function fillOfficialTextarea(textarea, text) {
  if (!textarea || typeof text !== 'string') return false
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set
  if (!setter) return false
  setter.call(textarea, text)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  return textarea.value === text
}

function noticeFor(result, t) {
  if (result?.ok) return ''
  const reason = result?.reason && result.reason in rabiQuestionLocales.en ? result.reason : 'failed'
  return `${t(reason)}${result?.message ? `: ${result.message}` : ''}`
}

function micIcon(recording) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', recording ? 'M8 8h8v8H8z' : 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm5 8a5 5 0 0 1-10 0M12 16v4M8 21h8')
  svg.append(path)
  return svg
}

function enhanceCustomField(field, { sessionId, t }) {
  if (field.dataset.rabiQuestionEnhanced === 'true') return () => {}
  field.dataset.rabiQuestionEnhanced = 'true'
  const box = field.parentNode
  if (!box) return () => {}
  const previousPosition = box.style.position
  const previousPadding = field.style.paddingRight
  if (!previousPosition || previousPosition === 'static') box.style.position = 'relative'
  field.style.paddingRight = '36px'
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.rabiQuestionMic = 'true'
  button.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);z-index:5;width:28px;height:28px;border:0;border-radius:999px;padding:0;background:transparent;color:inherit;cursor:pointer;pointer-events:auto;display:inline-flex;align-items:center;justify-content:center'
  box.append(button)
  let recorder = null
  const setState = key => {
    button.replaceChildren(micIcon(key === 'stop'))
    button.title = t(key)
    button.setAttribute('aria-label', `${t('branch')} · ${t(key)}`)
  }
  setState('record')
  const stopTracks = stream => { for (const track of stream.getTracks()) track.stop() }
  const finish = async (stream, context, samples, rate) => {
    stopTracks(stream)
    await context.close().catch(() => {})
    const length = samples.reduce((sum, chunk) => sum + chunk.length, 0)
    const pcm = new Float32Array(length)
    let offset = 0
    for (const chunk of samples) { pcm.set(chunk, offset); offset += chunk.length }
    const wav = encodePcmWav(pcm, rate)
    if (!wav) { setState('record'); button.title = t('bad-request'); return }
    setState('busy')
    const response = await fetch('/rabiroute/speech/asr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, mimeType: 'audio/wav', audio: bytesToBase64(wav) }),
    })
    const result = await response.json()
    if (!result?.ok) { setState('record'); button.title = noticeFor(result, t); return }
    fillOfficialTextarea(field, result.text)
    setState('record')
  }
  button.onclick = async event => {
    event.preventDefault()
    event.stopPropagation()
    if (recorder) {
      recorder.processor.disconnect()
      recorder.source.disconnect()
      recorder.mute.disconnect()
      const current = recorder
      recorder = null
      await finish(current.stream, current.context, current.samples, current.rate)
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      button.title = t('unsupported')
      return
    }
    let stream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { button.title = t('denied'); return }
    const context = new AudioContext({ sampleRate: 16000 })
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const mute = context.createGain()
    mute.gain.value = 0
    const samples = []
    processor.onaudioprocess = event => { samples.push(new Float32Array(event.inputBuffer.getChannelData(0))) }
    source.connect(processor)
    processor.connect(mute)
    mute.connect(context.destination)
    recorder = { stream, context, source, processor, mute, samples, rate: context.sampleRate || 16000 }
    setState('stop')
    window.setTimeout(() => { if (recorder && button.isConnected) button.click() }, 20000)
  }
  return () => {
    button.onclick = null
    if (recorder) {
      recorder.processor.disconnect()
      recorder.source.disconnect()
      recorder.mute.disconnect()
      stopTracks(recorder.stream)
      recorder.context.close().catch(() => {})
      recorder = null
    }
    button.remove()
    box.style.position = previousPosition
    field.style.paddingRight = previousPadding
    delete field.dataset.rabiQuestionEnhanced
  }
}

function isOfficialQuestionField(field) {
  return field?.placeholder === '输入你的答案' || field?.placeholder === 'Type your answer'
}

function attachRabiQuestionExtras(root, options) {
  if (!root || typeof root.querySelectorAll !== 'function') return () => {}
  const cleanups = new Map()
  const sync = () => {
    const fields = [...root.querySelectorAll('textarea')].filter(field => options?.all || isOfficialQuestionField(field) || root.dataset?.rabiQuestion === 'true')
    for (const [field, cleanup] of cleanups) {
      if (!field.isConnected || !fields.includes(field)) { cleanup(); cleanups.delete(field) }
    }
    for (const field of fields) {
      if (!cleanups.has(field)) cleanups.set(field, enhanceCustomField(field, options))
    }
  }
  sync()
  if (typeof MutationObserver !== 'function' || typeof root.querySelectorAll !== 'function') {
    return () => { for (const cleanup of cleanups.values()) cleanup() }
  }
  const observer = new MutationObserver(sync)
  observer.observe(root, { childList: true, subtree: true })
  return () => { observer.disconnect(); for (const cleanup of cleanups.values()) cleanup() }
}

/** Keep the official composer; mark the custom branch and add Rabi ASR. */
function RabiQuestionComposer({ Official, rabiQuestionT, ...props }) {
  const root = React.useRef(null)
  React.useEffect(() => attachRabiQuestionExtras(root.current, { sessionId: props.sessionId, t: rabiQuestionT }), [props.matched?.key, props.sessionId, rabiQuestionT])
  return React.createElement('div', { ref: root, 'data-rabi-question': true }, React.createElement(Official, props))
}

function officialQuestionComposer(entries) {
  return entries.find(entry => entry.options.locale === 'question' && entry.options.priority !== -10)
}

function registerRabiQuestionComposer(ctx) {
  ctx.effect(() => ctx.locale.register('rabiroute-question', rabiQuestionLocales))
  ctx.effect(() => {
    const root = typeof document === 'undefined' ? null : document.querySelector('[data-composer-seat]') || document.body
    if (!root) return () => {}
    return attachRabiQuestionExtras(root, { sessionId: 'composer', t: ctx.locale.bind('rabiroute-question') })
  })
  ctx.slots.inject('conversation.composer', () => {
    let dispose
    const wrap = () => {
      if (dispose) return
      const original = officialQuestionComposer(ctx.slots.entries('conversation.composer'))
      if (!original) return
      dispose = ctx.slots.register({
        name: 'conversation.composer',
        priority: -10,
        locale: original.options.locale,
        select: original.options.select,
        store: original.options.store,
        inject: sessionId => ({ ...(typeof original.inject === 'function' ? original.inject(sessionId) : {}), rabiQuestionT: ctx.locale.bind('rabiroute-question') }),
      }, props => React.createElement(RabiQuestionComposer, { ...props, Official: original.component, key: props.matched?.key }))
    }
    wrap()
    const timer = dispose || typeof setInterval !== 'function' ? undefined : setInterval(wrap, 100)
    return () => { if (timer !== undefined && typeof clearInterval === 'function') clearInterval(timer); dispose?.() }
  })
}

/** Public user/steering renderer replacement; durable content is never rewritten. */

/** Split the public content array without losing unknown blocks or text whitespace. */
function rabiContentParts(content) {
  const texts = [], attachments = [], rest = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block?.type === 'image' && block.attachment != null) attachments.push({ type: 'image', image: { attachment: block.attachment } })
    else if (block?.type === 'file' && block.attachment != null) attachments.push({ type: 'file', file: block.attachment })
    else rest.push(block)
  }
  return { text: texts.join(''), attachments, rest }
}

/** The Host route that asks Rabi to bring another client's session forward. */
const RABI_LOCATE_AGENT_PATH = '/rabiroute/locate-agent'

/**
 * Ask the Host to bring a non-DSH sender forward.
 *
 * A `codex` row names a session in the Codex desktop window, which this client cannot
 * open: the Host forwards the request to Rabi's own Agent-thread bridge, and Rabi decides
 * whether that window exists and can be raised. A failure is Rabi's own stated reason,
 * never a silently treated success.
 * @param sender - the envelope's sender identity.
 * @param signal - aborts the request when the row unmounts.
 * @returns Rabi's outcome, or a stated reason the Host could not be asked.
 */
async function locateExternalRabiSender(sender, signal) {
  const response = await fetch(RABI_LOCATE_AGENT_PATH, {
    method: 'POST',
    signal,
    cache: 'no-store',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ agentAdapter: sender.agentAdapter, threadId: sender.sessionId }),
  })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const payload = await response.json()
  const data = payload?.data
  if (!data || typeof data !== 'object') throw new Error('The locate route returned no outcome.')
  return data
}

/** Resolve an exact host-listed DSH identity only; never create, guess, or route external IDs. */
async function openRabiSender(sessions, sender, t, isActive = () => true, signal) {
  // A DSH session lives in the client that is already open, so it is selected in place.
  // Any other adapter belongs to another window and only Rabi can say whether it can be
  // raised, so it goes through the Host route rather than being refused here.
  if (sender.agentAdapter.toLowerCase() !== 'dsh') {
    const outcome = await locateExternalRabiSender(sender, signal)
    if (!isActive()) return
    if (!outcome.ok) throw new Error(outcome.message || t('external', { adapter: sender.agentAdapter }))
    return
  }
  await sessions.refresh()
  if (!isActive()) return
  const snapshot = sessions.list.getSnapshot()
  if (snapshot.phase !== 'ready') throw new Error(t('unavailable'))
  if (!snapshot.ids.includes(sender.sessionId) || snapshot.byId[sender.sessionId]?.id !== sender.sessionId) {
    throw new Error(t('unknown', { id: sender.sessionId }))
  }
  sessions.open(sender.sessionId)
}

/**
 * The folded row's own header label for one envelope.
 *
 * An `agent` envelope names a locatable session, so the row offers navigation.
 * A `plan` or `system` envelope names no session at all — those rows state what
 * the message is about instead, and must never render a locate control, because
 * there is nothing to locate and a dead control would read as a broken link.
 * @param {object} envelope - The parsed projection.
 * @param {Function} t - The locale seat.
 * @returns {{label: string, locate: boolean}} Folded-row label and whether navigation applies.
 */
function rabiEnvelopeHeader(envelope, t) {
  if (envelope.sourceType === 'agent') {
    return { label: t('fromAgent', { name: envelope.sender.sessionName, adapter: envelope.sender.agentAdapter }), locate: true }
  }
  if (envelope.sourceType === 'plan') {
    const source = envelope.plan.sourceAgent
    const name = t('planTitle', { name: envelope.plan.planName, id: envelope.plan.planId })
    return { label: source ? `${t('fromPlan')} · ${name} · ${t('fromAgent', { name: source.sessionName, adapter: source.agentAdapter })}` : `${t('fromPlan')} · ${name}`, locate: false }
  }
  return { label: `${t('fromSystem')} · ${t('eventTitle', { name: envelope.event.eventName })} · ${t('eventKind', { type: envelope.event.eventType })}`, locate: false }
}

/** Render historical or live user/steering data with public primitives and owner image presentation. */
function RabiMessageNodeView({ node, renderMessageImages, t, rabiSessions }) {
  const { text, attachments, rest } = rabiContentParts(node.data.content)
  const envelope = parseRabiMessageEnvelope(text)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [rawOpen, setRawOpen] = React.useState(false)
  // A parsed envelope folds by default: the body is model-facing text, not
  // something the reader asked to see. Unparsed text has no folded form, so it
  // stays expanded rather than hiding content behind a header that says nothing.
  const [expanded, setExpanded] = React.useState(false)
  const [notice, setNotice] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const rabiActive = React.useRef(true)
  const rabiLocateAbort = React.useRef(null)
  React.useEffect(() => () => {
    rabiActive.current = false
    // A locate that outlives its row would raise another client's window for a message
    // the reader has already navigated away from.
    rabiLocateAbort.current?.abort()
  }, [])
  const header = envelope && rabiEnvelopeHeader(envelope, t)
  const locate = async () => {
    if (busy || !envelope || !header?.locate) return
    setBusy(true)
    setNotice(null)
    const controller = new AbortController()
    rabiLocateAbort.current = controller
    try { await openRabiSender(rabiSessions, envelope.sender, t, () => rabiActive.current, controller.signal) }
    catch (error) { if (rabiActive.current) setNotice({ error: true, text: t('navigationFailed', { error: error instanceof Error ? error.message : String(error) }) }) }
    finally { if (rabiActive.current) setBusy(false); if (rabiLocateAbort.current === controller) rabiLocateAbort.current = null }
  }
  const copy = async () => {
    try {
      const ok = await writeClipboard(text)
      if (rabiActive.current) setNotice({ error: !ok, text: t(ok ? 'copied' : 'copyFailed') })
    } catch {
      // Clipboard failures remain local UI errors; no alternate write channel is attempted.
      if (rabiActive.current) setNotice({ error: true, text: t('copyFailed') })
    }
  }
  const referenceLabels = node.data.referenceLabels ?? []
  const skillNames = node.data.skillNames ?? []
  const displayedText = envelope ? envelope.body : text
  const timestampCandidate = typeof node.data.time === 'number' && Number.isFinite(node.data.time) ? new Date(node.data.time) : null
  const timestamp = timestampCandidate !== null && Number.isFinite(timestampCandidate.getTime()) ? timestampCandidate : null
  const sourceKind = envelope ? envelope.sourceType : 'ordinary'
  const menuItems = header?.locate
    ? [{ id: 'raw', label: t('raw') }, { id: 'locate', label: t('locate'), disabled: busy }]
    : [{ id: 'raw', label: t('raw') }]
  // Built lazily: a folded row must not run the model-facing projection, which
  // is the expensive part and whose output is not on screen anyway.
  const body = () => React.createElement(React.Fragment, null,
    (displayedText !== '' || rest.length > 0) && React.createElement('div', { style: rabiClientStyles.bubble },
      projectUserText(displayedText, referenceLabels, skillNames),
      rest.map((block, index) => React.createElement(JsonBlock, { key: index, payload: block, label: t('extra'), truncatedLabel: total => t('truncated', { total }) }))),
    referenceLabels.length > 0 && React.createElement('div', { style: rabiClientStyles.muted }, t('references', { labels: referenceLabels.join(t('separator')) })))
  // An `agent` envelope keeps its body visible: that row's header is a locate
  // control, not a disclosure, and folding it would hide content this renderer
  // has always shown. A `plan` or `system` envelope has no such control, so it
  // folds — which is the whole point of parsing them.
  const folds = envelope !== null && envelope.sourceType !== 'agent'
  const bodyVisible = !folds || expanded
  return React.createElement('section', { style: rabiClientStyles.row, 'data-rabi-message': sourceKind },
    React.createElement('div', { style: rabiClientStyles.stack },
      envelope && React.createElement('header', { style: rabiClientStyles.header },
        header.locate
          ? React.createElement(Button, { size: 'sm', variant: 'ghost', style: rabiClientStyles.sender, title: t('senderHint'), disabled: busy, onClick: locate }, header.label)
          : React.createElement(Button, { size: 'sm', variant: 'ghost', style: rabiClientStyles.sender, 'aria-expanded': expanded, onClick: () => setExpanded(value => !value) }, header.label),
        React.createElement(Menu, {
          open: menuOpen, portal: true, align: 'end',
          anchor: React.createElement(Button, { size: 'sm', variant: 'ghost', 'aria-label': t('more'), 'aria-haspopup': 'menu', 'aria-expanded': menuOpen, onClick: () => setMenuOpen(value => !value) }, '…'),
          items: menuItems,
          onClose: () => setMenuOpen(false),
          onSelect: id => { setMenuOpen(false); if (id === 'raw') setRawOpen(true); else if (id === 'locate') void locate() },
        })),
      attachments.length > 0 && React.createElement('div', { style: rabiClientStyles.attachments, 'data-message-attachments': true },
        attachments.map((attachment, index) => attachment.type === 'image'
          ? React.createElement(React.Fragment, { key: `image:${index}` }, renderMessageImages({ images: [attachment.image], align: 'end', compact: attachments.length > 1 }))
          : React.createElement('span', { key: `file:${index}`, style: rabiClientStyles.file, title: attachment.file.name },
            React.createElement('span', null, attachment.file.name),
            React.createElement('span', { style: rabiClientStyles.muted }, [attachment.file.mediaType, fileSizeText(attachment.file.bytes)].filter(Boolean).join(' · '))))),
      bodyVisible && body()),
    React.createElement('div', { style: rabiClientStyles.actions },
      timestamp && React.createElement('time', { dateTime: timestamp.toISOString(), title: timestamp.toLocaleString(), style: rabiClientStyles.muted }, timestamp.toLocaleString()),
      folds && React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: () => setExpanded(value => !value) }, t(expanded ? 'collapse' : 'expand')),
      React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: copy }, t('copy'))),
    notice && React.createElement('div', { role: notice.error ? 'alert' : 'status', style: rabiClientStyles.muted }, notice.text),
    envelope && React.createElement(Modal, { open: rawOpen, title: t('raw'), closeLabel: t('close'), onClose: () => setRawOpen(false) },
      React.createElement('pre', { style: rabiClientStyles.raw }, envelope.raw)))
}

const inject = ['slots', 'sessions', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** Register reversible, explicitly ranked replacements; nonmatching rows do not delegate. */
function apply(ctx) {
  registerRabiQuestionComposer(ctx)
  ctx.effect(() => ctx.locale.register('rabiroute-speech', rabiSpeechLocales))
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'rabiroute-speech', order: 30, locale: 'rabiroute-speech',
  }, props => React.createElement(RabiSpeechAction, { ...props, key: `${props.sessionId}:${props.messageId}` })))
  ctx.effect(() => ctx.locale.register('rabiroute-agent-messages', rabiClientLocales))
  for (const key of ['user', 'steering']) {
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node', key, priority: -10, locale: 'rabiroute-agent-messages',
      inject: () => ({ rabiSessions: ctx.sessions }),
    }, props => React.createElement(RabiMessageNodeView, { ...props, key: `${props.sessionId}:${props.node.id ?? props.node.key ?? key}` })))
  }
  // The plan panel: a page type whose body frames Rabi's own WebGUI page. The type
  // is this plugin's own id in the tab system, so it composes with every other
  // type instead of taking one over.
  const planCopy = ctx.locale.bind(RABI_PLAN_NS)
  ctx.effect(() => ctx.locale.register(RABI_PLAN_NS, rabiPlanLocales), 'dsh-rabiroute-agent: plan copy')
  ctx.effect(() => ctx.sidebarRightTabs.register(rabiPlanTabDefinition(planCopy)), 'dsh-rabiroute-agent: plan tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: RABI_PLAN_TAB_ID, locale: RABI_PLAN_NS,
  }, RabiPlanBody)), 'dsh-rabiroute-agent: plan body')
  // The entry appears only where a Rabi binding exists, and opens the panel once
  // for that session; both decisions come from the Host route, not from local state.
  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'rabiroute-agent-plan', order: 30, locale: RABI_PLAN_NS,
    inject: () => ({ openRabiPlanTab: () => { ctx.sidebarRight.openTab(RABI_PLAN_KIND) } }),
  }, RabiPlanLauncher)), 'dsh-rabiroute-agent: plan launcher')
}

    return { inject, apply }
  },
})
