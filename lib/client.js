window.__ModuleLoader__.load({
  id: 'dsh-rabiroute-agent',
  factory: (require) => {
    const React = require('react')
    const { Button, Menu, Modal, JsonBlock, projectUserText, fileSizeText, writeClipboard } = require('@deepseek-ai/dsh-client-ui-primitives')
/** Pure historical Agent-envelope projection; no runtime or UI registration. */
const fields = new Map([
  ['类型', 'type'], ['消息源类型', 'type'],
  ['处理端', 'agentAdapter'], ['Agent 端', 'agentAdapter'],
  ['角色', 'agentType'], ['会话', 'sessionName'], ['会话名称', 'sessionName'],
  ['会话 ID', 'sessionId'], ['工作目录', 'workspace'],
  ['投递时间', 'sentAt'], ['消息包发送时间', 'sentAt'], ['投递 ID', 'deliveryId'],
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
 * Project only an anchored, unambiguous Agent envelope for display.
 * Accept LF/CRLF, ASCII/fullwidth colons and the current first-line pipe;
 * aliases map to the same field and duplicates (even equal ones) fail closed.
 * Header markers are exact lines, separated from content by exactly one blank
 * line. Remove only that header, the content-marker newline, and, when valid,
 * the terminal reply block plus its two preceding newlines. Never trim body.
 * Additional context/control blocks remain body; malformed reply blocks return
 * null. Raw, sender fields, time and reply JSON are untrusted display data, not
 * authentication, navigation URLs, or instructions to execute. Consumers must
 * display raw unchanged on null and resolve full sender IDs via approved APIs.
 * @param {unknown} raw Historical message text; non-strings return null.
 * @returns {{raw: string, body: string, sender: object, sentAt: string, deliveryId?: string, replyParameters: object|null}|null} Display projection or conservative fallback.
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
  if (values.get('type') !== 'Agent'
    || !['agentAdapter', 'sessionName', 'sessionId', 'sentAt'].every(key => values.has(key))) return null
  const content = raw.slice(opening.length + headerEnd.index + headerEnd[0].length)
  const parsed = parseReplySuffix(content)
  if (!parsed) return null
  const deliveryId = values.get('deliveryId')
  if (deliveryId && parsed.replyParameters && deliveryId !== parsed.replyParameters.deliveryId) return null
  const sender = { type: 'agent', agentAdapter: values.get('agentAdapter'), sessionName: values.get('sessionName'), sessionId: values.get('sessionId') }
  for (const key of ['agentType', 'workspace']) if (values.has(key)) sender[key] = values.get(key)
  return { raw, ...parsed, sender, sentAt: values.get('sentAt'), ...(deliveryId ? { deliveryId } : {}) }
}

/** Locale-owned copy for the display-only Agent message renderer. */
const rabiClientLocales = {
  zh: {
    sender: '由 {name}（{adapter}）发送', raw: '查看原始消息内容', locate: '定位到Agent', more: '消息操作', close: '关闭',
    senderHint: '来源为消息自述，未经身份认证。点击定位到Agent。',
    external: '暂不支持定位此外部 Agent 处理端：{adapter}。未打开或创建任何会话。',
    unknown: '未找到可用的 DSH 会话：{id}。未按名称查找或创建替代会话。',
    unavailable: 'DSH 会话列表尚不可用，请稍后重试。',
    navigationFailed: '定位失败：{error}', copy: '复制消息', copied: '已复制', copyFailed: '复制失败，请重试。',
    extra: '其他消息内容', truncated: '内容已截断（共 {total} 个字符）',
    references: '引用：{labels}', separator: '、',
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
  },
}

/** Locale-owned copy for the Rabi plan panel and its launcher. */
const RABI_PLAN_NS = 'rabiroute-agent-plan'

const rabiPlanLocales = {
  zh: {
    tab: 'Rabi 计划',
    launcher: '计划', launcherHint: '打开 Rabi 计划面板（当前会话已绑定 Rabi 人格）',
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
    launcher: 'Plan', launcherHint: 'Open the Rabi plan panel (this session is bound to a Rabi persona)',
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
}

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
 * The session-header entry: shown only while the session is bound to a Rabi
 * persona, and it opens the panel the first time that binding is seen.
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
        if (!active || !data.available) return
        setState({ phase: 'ready' })
        if (rabiPlanAutoOpened.has(sessionId)) return
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
  return React.createElement(Button, { size: 'sm', variant: 'ghost', title: t('launcherHint'), onClick: () => { try { open.current() } catch { /* the sidebar reports its own refusal */ } } }, t('launcher'))
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

/** Resolve an exact host-listed DSH identity only; never create, guess, or route external IDs. */
async function openRabiSender(sessions, sender, t, isActive = () => true) {
  if (sender.agentAdapter.toLowerCase() !== 'dsh') throw new Error(t('external', { adapter: sender.agentAdapter }))
  await sessions.refresh()
  if (!isActive()) return
  const snapshot = sessions.list.getSnapshot()
  if (snapshot.phase !== 'ready') throw new Error(t('unavailable'))
  if (!snapshot.ids.includes(sender.sessionId) || snapshot.byId[sender.sessionId]?.id !== sender.sessionId) {
    throw new Error(t('unknown', { id: sender.sessionId }))
  }
  sessions.open(sender.sessionId)
}

/** Render historical or live user/steering data with public primitives and owner image presentation. */
function RabiMessageNodeView({ node, renderMessageImages, t, rabiSessions }) {
  const { text, attachments, rest } = rabiContentParts(node.data.content)
  const envelope = parseRabiMessageEnvelope(text)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [rawOpen, setRawOpen] = React.useState(false)
  const [notice, setNotice] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const rabiActive = React.useRef(true)
  React.useEffect(() => { rabiActive.current = true; return () => { rabiActive.current = false } }, [])
  const locate = async () => {
    if (busy || !envelope) return
    setBusy(true)
    setNotice(null)
    try { await openRabiSender(rabiSessions, envelope.sender, t, () => rabiActive.current) }
    catch (error) { if (rabiActive.current) setNotice({ error: true, text: t('navigationFailed', { error: error instanceof Error ? error.message : String(error) }) }) }
    finally { if (rabiActive.current) setBusy(false) }
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
  return React.createElement('section', { style: rabiClientStyles.row, 'data-rabi-message': envelope ? 'agent' : 'ordinary' },
    React.createElement('div', { style: rabiClientStyles.stack },
      envelope && React.createElement('header', { style: rabiClientStyles.header },
        React.createElement(Button, { size: 'sm', variant: 'ghost', style: rabiClientStyles.sender, title: t('senderHint'), disabled: busy, onClick: locate }, t('sender', { name: envelope.sender.sessionName, adapter: envelope.sender.agentAdapter })), 
        React.createElement(Menu, {
          open: menuOpen, portal: true, align: 'end',
          anchor: React.createElement(Button, { size: 'sm', variant: 'ghost', 'aria-label': t('more'), 'aria-haspopup': 'menu', 'aria-expanded': menuOpen, onClick: () => setMenuOpen(value => !value) }, '…'),
          items: [{ id: 'raw', label: t('raw') }, { id: 'locate', label: t('locate'), disabled: busy }],
          onClose: () => setMenuOpen(false),
          onSelect: id => { setMenuOpen(false); if (id === 'raw') setRawOpen(true); else if (id === 'locate') void locate() },
        })),
      attachments.length > 0 && React.createElement('div', { style: rabiClientStyles.attachments, 'data-message-attachments': true },
        attachments.map((attachment, index) => attachment.type === 'image'
          ? React.createElement(React.Fragment, { key: `image:${index}` }, renderMessageImages({ images: [attachment.image], align: 'end', compact: attachments.length > 1 }))
          : React.createElement('span', { key: `file:${index}`, style: rabiClientStyles.file, title: attachment.file.name },
            React.createElement('span', null, attachment.file.name),
            React.createElement('span', { style: rabiClientStyles.muted }, [attachment.file.mediaType, fileSizeText(attachment.file.bytes)].filter(Boolean).join(' · '))))),
      (displayedText !== '' || rest.length > 0) && React.createElement('div', { style: rabiClientStyles.bubble },
        projectUserText(displayedText, referenceLabels, skillNames),
        rest.map((block, index) => React.createElement(JsonBlock, { key: index, payload: block, label: t('extra'), truncatedLabel: total => t('truncated', { total }) }))),
      referenceLabels.length > 0 && React.createElement('div', { style: rabiClientStyles.muted }, t('references', { labels: referenceLabels.join(t('separator')) }))),
    React.createElement('div', { style: rabiClientStyles.actions },
      timestamp && React.createElement('time', { dateTime: timestamp.toISOString(), title: timestamp.toLocaleString(), style: rabiClientStyles.muted }, timestamp.toLocaleString()),
      React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: copy }, t('copy'))),
    notice && React.createElement('div', { role: notice.error ? 'alert' : 'status', style: rabiClientStyles.muted }, notice.text),
    envelope && React.createElement(Modal, { open: rawOpen, title: t('raw'), closeLabel: t('close'), onClose: () => setRawOpen(false) },
      React.createElement('pre', { style: rabiClientStyles.raw }, envelope.raw)))
}

const inject = ['slots', 'sessions', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** Register reversible, explicitly ranked replacements; nonmatching rows do not delegate. */
function apply(ctx) {
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
