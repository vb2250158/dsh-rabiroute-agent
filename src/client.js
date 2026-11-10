import { applyWorkspacePlans } from './client-workspace-plans.js'
import { applyRabiPlanStatus } from './client-plan-status.js'
/** Public user/steering renderer replacement; durable content is never rewritten. */
import * as React from 'react'
import { RabiSpeechAction, rabiSpeechLocales } from './client-speech.js'
import { registerRabiQuestionComposer } from './client-question.js'
import { Button, Menu, Modal, JsonBlock, projectUserText, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseRabiMessageEnvelope } from './message-envelope.js'
import { rabiClientLocales } from './client-locales.js'
import { RABI_PLAN_NS, rabiPlanLocales } from './client-plan-locales.js'
import { RABI_PLAN_KIND, RABI_PLAN_TAB_ID, RabiPlanBody, RabiPlanLauncher, rabiPlanTabDefinition } from './client-plan.js'
import { rabiClientStyles } from './client-styles.js'

/** Split the public content array without losing unknown blocks or text whitespace. */
export function rabiContentParts(content) {
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
export const RABI_LOCATE_AGENT_PATH = '/rabiroute/locate-agent'

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
export async function locateExternalRabiSender(sender, signal) {
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
export async function openRabiSender(sessions, sender, t, isActive = () => true, signal) {
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
export function rabiEnvelopeHeader(envelope, t) {
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

/**
 * Adapt a durable message to the same presentation used by submission echoes.
 * @param props - the durable node and the shared row Factory renderer.
 * @returns the shared user-message row.
 */
export function RabiMessageNodeView({ node, loadImage, renderFactorySlot }) {
  const { text, attachments, rest } = rabiContentParts(node.data.content)
  return renderFactorySlot('conversation.chat.user.row', {
    origin: { kind: 'durable', node },
    content: { text, attachments, extraBlocks: rest, referenceLabels: node.data.referenceLabels ?? [] },
    facts: { sessionLabels: node.data.referenceLabels ?? [], skillNames: node.data.skillNames ?? [] },
    loadImage,
    interactive: true,
  })
}

/**
 * Draw submission, pending and durable rows with one layout and attachment renderer.
 * @param props - prepared content, the real occurrence identity and session-bound presentation seats.
 * @returns the source card, optional answer card or ordinary user message.
 */
export function RabiUserRow({ origin, content, facts, interactive = false, ellipsis, sessionId, loadImage, renderFactorySlot, t, rabiSessions }) {
  const { text, attachments, extraBlocks: rest } = content
  const node = origin.kind === 'durable' ? origin.node : undefined
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
  const referenceLabels = content.referenceLabels ?? facts.sessionLabels ?? []
  const skillNames = facts.skillNames ?? []
  const displayedText = envelope ? envelope.body : text
  const sourceKind = envelope ? envelope.sourceType : 'ordinary'
  const menuItems = header?.locate
    ? [{ id: 'raw', label: t('raw') }, { id: 'locate', label: t('locate'), disabled: busy }]
    : [{ id: 'raw', label: t('raw') }]
  // Built lazily: a folded row must not run the model-facing projection, which
  // is the expensive part and whose output is not on screen anyway.
  const body = () => React.createElement(React.Fragment, null,
    (displayedText !== '' || rest.length > 0) && React.createElement('div', { style: bubbleStyle },
      typeof projectUserText === 'function'
        ? projectUserText(displayedText, referenceLabels, skillNames)
        : renderFactorySlot('conversation.user.text', { text: displayedText, facts: { ...facts, sessionLabels: referenceLabels, skillNames }, interactive }),
      rest.map((block, index) => React.createElement(JsonBlock, { key: index, payload: block, label: t('extra'), truncatedLabel: total => t('truncated', { total }) }))),
    referenceLabels.length > 0 && React.createElement('div', { style: rabiClientStyles.muted }, t('references', { labels: referenceLabels.join(t('separator')) })))
  // An `agent` envelope keeps its body visible: that row's header is a locate
  // control, not a disclosure, and folding it would hide content this renderer
  // has always shown. A `plan` or `system` envelope has no such control, so it
  // folds — which is the whole point of parsing them.
  const folds = envelope !== null && envelope.sourceType !== 'agent'
  const bodyVisible = !folds || expanded
  // Who wrote an ordinary message belongs to DS Bot's surface, not to this renderer: it
  // publishes the head for exactly its own conversations and answers null elsewhere, so
  // a plain DSH Session keeps the row it has always had.
  const userHead = envelope === null && typeof globalThis.__dshBotUserHead === 'function' ? globalThis.__dshBotUserHead(sessionId) : null
  // The head is DS Bot's answer alone; its absence means this is a plain DSH Session,
  // which keeps the bubble tone the shell has always shown.
  const bubbleStyle = userHead === null ? rabiClientStyles.bubble : rabiClientStyles.bubbleOnBotSurface
  const pending = origin.kind === 'pending-steering' || origin.kind === 'submission' && origin.submission.placement === 'steering'
  const fallback = React.createElement('section', {
    style: rabiClientStyles.row,
    'data-rabi-message': sourceKind,
    'data-submission-echo': origin.kind === 'submission' || undefined,
    'data-pending-steering': pending || undefined,
    'data-chat-steering-batch': node?.kind === 'steering' && node.data.batchStart === true ? 'start' : undefined,
  },
    userHead,
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
          ? React.createElement(React.Fragment, { key: `image:${index}` }, renderFactorySlot('conversation.images.content', { images: [attachment.image], loadImage, align: 'end', compact: attachments.length > 1 }))
          : React.createElement('span', { key: `file:${index}`, style: rabiClientStyles.file, title: attachment.file.name },
            React.createElement('span', null, attachment.file.name),
            React.createElement('span', { style: rabiClientStyles.muted }, [attachment.file.mediaType, fileSizeText(attachment.file.bytes)].filter(Boolean).join(' · '))))),
      bodyVisible && body()),
    envelope && React.createElement('div', { style: rabiClientStyles.actions },
      folds && React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: () => setExpanded(value => !value) }, t(expanded ? 'collapse' : 'expand'))),
    notice && React.createElement('div', { role: notice.error ? 'alert' : 'status', style: rabiClientStyles.muted }, notice.text),
    envelope && React.createElement(Modal, { open: rawOpen, title: t('raw'), closeLabel: t('close'), onClose: () => setRawOpen(false) },
      React.createElement('pre', { style: rabiClientStyles.raw }, envelope.raw)))
  return envelope ? fallback : renderFactorySlot('proactive-answer.message', {
    row: { origin, content, facts, interactive, ellipsis, loadImage }, fallback,
  }, { fallback })
}

export const inject = ['slots', 'sessions', 'locale', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace']

/** Register reversible, explicitly ranked replacements; nonmatching rows do not delegate. */
export function apply(ctx) {
  applyRabiPlanStatus(ctx)
  applyWorkspacePlans(ctx)
  registerRabiQuestionComposer(ctx)
  ctx.effect(() => ctx.locale.register('rabiroute-speech', rabiSpeechLocales))
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'rabiroute-speech', order: 30, locale: 'rabiroute-speech',
  }, props => React.createElement(RabiSpeechAction, { ...props, key: `${props.sessionId}:${props.messageId}` })))
  ctx.effect(() => ctx.locale.register('rabiroute-agent-messages', rabiClientLocales))
  ctx.slots.inject('conversation.chat.user.row.body', () => ctx.slots.register({
    name: 'conversation.chat.user.row.body', priority: -10, locale: 'rabiroute-agent-messages',
    inject: () => ({ rabiSessions: ctx.sessions }),
  }, RabiUserRow))
  for (const key of ['user', 'steering']) {
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node', key, priority: -10, locale: 'rabiroute-agent-messages',
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
  // The Host owns the binding; the sidebar owns its live layout. The entry only
  // remembers the user's per-session panel choice across view remounts.
  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'rabiroute-agent-plan', order: 30, locale: RABI_PLAN_NS,
    inject: () => ({
      openRabiPlanTab: () => { ctx.sidebarRight.openTab(RABI_PLAN_KIND) },
      getRabiPanelView: () => ({ expanded: ctx.sidebarRight.isExpanded(), activeKind: ctx.sidebarRight.active()?.kind }),
    }),
  }, RabiPlanLauncher)), 'dsh-rabiroute-agent: plan launcher')
}
