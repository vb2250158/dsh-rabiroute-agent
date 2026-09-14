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

const inject = ['slots', 'sessions', 'locale']

/** Register reversible, explicitly ranked replacements; nonmatching rows do not delegate. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register('rabiroute-agent-messages', rabiClientLocales))
  for (const key of ['user', 'steering']) {
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node', key, priority: -10, locale: 'rabiroute-agent-messages',
      inject: () => ({ rabiSessions: ctx.sessions }),
    }, props => React.createElement(RabiMessageNodeView, { ...props, key: `${props.sessionId}:${props.node.id ?? props.node.key ?? key}` })))
  }
}

    return { inject, apply }
  },
})
