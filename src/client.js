import { applyWorkspacePlans } from './client-workspace-plans.js'
import { applyRabiPlanStatus } from './client-plan-status.js'
/** Rabi metadata decorates official user text; DSH retains the complete message row. */
import * as React from 'react'
import { RabiSpeechAction, rabiSpeechLocales } from './client-speech.js'
import { registerRabiQuestionComposer } from './client-question.js'
import { Button, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { rabiMessageMetadataRule } from './message-envelope.js'
import { rabiClientLocales } from './client-locales.js'
import { RABI_PLAN_NS, rabiPlanLocales } from './client-plan-locales.js'
import { RABI_PLAN_KIND, RABI_PLAN_TAB_ID, RabiPlanBody, RabiPlanLauncher, rabiPlanTabDefinition } from './client-plan.js'
import { rabiClientStyles } from './client-styles.js'

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
 * The source metadata label for one envelope.
 *
 * An `agent` envelope names a locatable session, so the row offers navigation.
 * A `plan` or `system` envelope names no session at all — those rows state what
 * the message is about instead, and must never render a locate control, because
 * there is nothing to locate and a dead control would read as a broken link.
 * @param {object} envelope - The parsed projection.
 * @param {Function} t - The locale seat.
 * @returns {{label: string, locate: boolean}} Source label and whether navigation applies.
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
 * Decorate source metadata inside the official text, bubble and message row.
 * The body, attachments, clock and copy action stay with their official owners.
 * @param props - Metadata node and session-bound navigation and locale seats.
 * @returns an inline source decoration, or no visible reply metadata.
 */
export function RabiMessageMetadata({ node, interactive = false, t, rabiSessions }) {
  if (node.data.part !== 'source') return null
  return React.createElement(RabiSourceHeader, { envelope: node.data.envelope, interactive, t, rabiSessions })
}

/** Source controls never replace or collapse the message body. */
export function RabiSourceHeader({ envelope, interactive, t, rabiSessions }) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [rawOpen, setRawOpen] = React.useState(false)
  const [notice, setNotice] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const active = React.useRef(true)
  const locateAbort = React.useRef(null)
  React.useEffect(() => {
    active.current = true
    return () => { active.current = false; locateAbort.current?.abort() }
  }, [])
  const header = rabiEnvelopeHeader(envelope, t)
  const locate = async () => {
    if (!interactive || busy || !header.locate) return
    setBusy(true)
    setNotice(null)
    const controller = new AbortController()
    locateAbort.current = controller
    try { await openRabiSender(rabiSessions, envelope.sender, t, () => active.current, controller.signal) }
    catch (error) { if (active.current) setNotice(t('navigationFailed', { error: error instanceof Error ? error.message : String(error) })) }
    finally { if (active.current) setBusy(false); if (locateAbort.current === controller) locateAbort.current = null }
  }
  const items = header.locate
    ? [{ id: 'raw', label: t('raw') }, { id: 'locate', label: t('locate'), disabled: busy }]
    : [{ id: 'raw', label: t('raw') }]
  return React.createElement('span', { style: rabiClientStyles.source, 'data-rabi-source': envelope.sourceType },
    React.createElement('span', { style: rabiClientStyles.header },
      interactive && header.locate
        ? React.createElement(Button, { size: 'sm', variant: 'ghost', style: rabiClientStyles.sender, title: t('senderHint'), disabled: busy, onClick: locate }, header.label)
        : React.createElement('span', { style: rabiClientStyles.muted }, header.label),
      interactive && React.createElement(Menu, {
        open: menuOpen, portal: true, align: 'end',
        anchor: React.createElement(Button, { size: 'sm', variant: 'ghost', 'aria-label': t('more'), 'aria-haspopup': 'menu', 'aria-expanded': menuOpen, onClick: () => setMenuOpen(value => !value) }, '…'),
        items, onClose: () => setMenuOpen(false),
        onSelect: id => { setMenuOpen(false); if (id === 'raw') setRawOpen(true); else if (id === 'locate') void locate() },
      })),
    notice && React.createElement('span', { role: 'alert', style: rabiClientStyles.muted }, notice),
    interactive && React.createElement(Modal, { open: rawOpen, title: t('raw'), closeLabel: t('close'), onClose: () => setRawOpen(false) },
      React.createElement('pre', { style: rabiClientStyles.raw }, envelope.raw)))
}

export const inject = ['slots', 'sessions', 'locale', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace', 'uiConversation']

/** Register effect-owned source nodes without replacing official message renderers. */
export function apply(ctx) {
  applyRabiPlanStatus(ctx)
  applyWorkspacePlans(ctx)
  registerRabiQuestionComposer(ctx)
  ctx.effect(() => ctx.locale.register('rabiroute-speech', rabiSpeechLocales))
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'rabiroute-speech', order: 30, locale: 'rabiroute-speech',
  }, props => React.createElement(RabiSpeechAction, { ...props, key: `${props.sessionId}:${props.messageId}` })))
  ctx.effect(() => ctx.locale.register('rabiroute-agent-messages', rabiClientLocales))
  ctx.effect(() => ctx.uiConversation.userText.register(rabiMessageMetadataRule), 'dsh-rabiroute-agent: source metadata')
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: rabiMessageMetadataRule.id, locale: 'rabiroute-agent-messages',
    inject: () => ({ rabiSessions: ctx.sessions }),
  }, RabiMessageMetadata))
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
