/** Public user/steering renderer replacement; durable content is never rewritten. */
import * as React from 'react'
import { Button, Menu, Modal, JsonBlock, projectUserText, fileSizeText, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseRabiMessageEnvelope } from './message-envelope.js'
import { rabiClientLocales } from './client-locales.js'
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

/** Resolve an exact host-listed DSH identity only; never create, guess, or route external IDs. */
export async function openRabiSender(sessions, sender, t, isActive = () => true) {
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
export function RabiMessageNodeView({ node, renderMessageImages, t, rabiSessions }) {
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

export const inject = ['slots', 'sessions', 'locale']

/** Register reversible, explicitly ranked replacements; nonmatching rows do not delegate. */
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('rabiroute-agent-messages', rabiClientLocales))
  for (const key of ['user', 'steering']) {
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node', key, priority: -10, locale: 'rabiroute-agent-messages',
      inject: () => ({ rabiSessions: ctx.sessions }),
    }, props => React.createElement(RabiMessageNodeView, { ...props, key: `${props.sessionId}:${props.node.id ?? props.node.key ?? key}` })))
  }
}
