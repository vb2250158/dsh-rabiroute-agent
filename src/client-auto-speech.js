import * as React from 'react'
import { RabiSpeechAction } from './client-speech.js'

/** Observe the optional speech service's persisted reply-reading preference. */
export function createRabiAutoReadStore(ctx) {
  let enabled = false, disposed = false
  const listeners = new Set()
  const set = value => {
    if (enabled === value) return
    enabled = value
    for (const listener of listeners) listener()
  }
  const stream = ctx.remote.$stream({
    name: 'Rabi reply-reading preferences',
    open: signal => ctx.remote.speech.follow(signal),
    ended: () => new Error('Speech preferences disconnected'),
    carrierFailed: () => set(false),
  })
  const observing = (async () => {
    try {
      for await (const item of stream) {
        if (disposed) break
        set(item.value.inputPreferences.autoRead === true)
        item.accept()
      }
    } catch (error) {
      // A missing or disconnected optional service disables automatic reading.
      if (!disposed) set(false)
    }
  })()
  return {
    getSnapshot: () => enabled,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    dispose: async () => { disposed = true; set(false); await stream.dispose(); await observing; listeners.clear() },
  }
}

/** Track only replies arriving after the initial ready Session snapshot. */
export function createRabiReplyGate() {
  let primed = false, lastSeq = -1
  return {
    reset: () => { primed = false; lastSeq = -1 },
    take(snapshot, ready, enabled) {
      if (!ready) { primed = false; return [] }
      const nodes = snapshot.eventNodes
      const newest = nodes.reduce((seq, node) => Math.max(seq, node.seq), lastSeq)
      if (!primed) { primed = true; lastSeq = newest; return [] }
      const replies = enabled ? nodes.filter(node => node.seq > lastSeq && node.kind === 'assistant'
        && node.messageId && !node.interrupted && !node.blocks.some(block => block.kind === 'tool-call')
        && node.blocks.some(block => block.kind === 'text' && block.text.trim())) : []
      lastSeq = newest
      return replies.sort((left, right) => left.seq - right.seq).map(node => node.messageId)
    },
  }
}

/** Read new replies serially in the active Session; unmount stops synthesis and playback. */
export function RabiAutoSpeech({ sessionId, useTrajectory, useSession, useRabiAutoRead, t }) {
  const snapshot = useTrajectory(value => value)
  const ready = useSession(value => value.openState === 'open')
  const enabled = useRabiAutoRead(value => value)
  const gate = React.useRef(null)
  if (!gate.current) gate.current = createRabiReplyGate()
  const [queue, setQueue] = React.useState([])
  const [visible, setVisible] = React.useState(!document.hidden)
  React.useEffect(() => {
    const replies = gate.current.take(snapshot, ready && visible, enabled)
    if (!ready || !enabled || !visible) setQueue(current => current.length ? [] : current)
    else if (replies.length) setQueue(current => [...current, ...replies])
  }, [snapshot, ready, enabled, visible])
  React.useEffect(() => {
    const hide = () => { setVisible(!document.hidden) }
    document.addEventListener('visibilitychange', hide)
    return () => { document.removeEventListener('visibilitychange', hide) }
  }, [])
  const messageId = queue[0]
  if (!enabled || !ready || !visible || !messageId) return null
  return React.createElement(RabiSpeechAction, {
    key: `${sessionId}:${messageId}`, sessionId, messageId, useTrajectory, t, autoPlay: true,
    onFinished: () => setQueue(current => current.filter(id => id !== messageId)),
  })
}

/** Optional integration; ordinary manual reading works without the speech input bundle. */
export function registerRabiAutoSpeech(ctx) {
  ctx.inject(['remote', 'remote.speech'], runtime => {
    const preferences = createRabiAutoReadStore(runtime)
    runtime.effect(() => preferences.dispose)
    runtime.effect(() => runtime.slots.inject('conversation.session.header.actions', () => runtime.slots.register({
      name: 'conversation.session.header.actions', id: 'rabiroute-auto-speech', order: 35, locale: 'rabiroute-speech',
      inject: () => ({ hooks: { rabiAutoRead: preferences } }),
    }, props => React.createElement(RabiAutoSpeech, { ...props, key: props.sessionId }))))
  })
}
