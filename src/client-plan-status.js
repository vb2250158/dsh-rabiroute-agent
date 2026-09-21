import * as React from 'react'
import { Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { createPlanStatusStore } from './client-plan-status-store.js'

const rabiStatusLocales = {
  zh: { conflict: '多个计划', stale: '缓存状态，等待刷新', plan: 'Rabi 计划状态' },
  en: { conflict: 'Multiple plans', stale: 'Cached status, awaiting refresh', plan: 'Rabi plan status' },
}

/** The owner supplies the row identity, independently of the selected session. */
export function RabiPlanStatusBadge({ sessionId, statusStore, t }) {
  const snapshot = React.useSyncExternalStore(statusStore.subscribe, statusStore.getSnapshot, statusStore.getSnapshot)
  const entry = snapshot.entries[sessionId]
  if (!entry) return null
  const label = entry.conflict ? t('conflict') : entry.status
  if (!label) return null
  return React.createElement(Tooltip, { label: t('plan') + ': ' + label + (snapshot.stale ? ' · ' + t('stale') : '') },
    React.createElement('span', { style: { flexShrink: 0, maxWidth: '7em', overflow: 'hidden', fontSize: '10px' }, 'data-rabi-plan-status': sessionId },
      React.createElement(Tag, { tone: entry.conflict || snapshot.stale ? 'warning' : 'info' }, label + (snapshot.stale ? ' ·' : ''))))
}

/** Lifecycle-owned registration and shared request scheduler. */
export function applyRabiPlanStatus(ctx) {
  ctx.effect(() => ctx.locale.register('rabi-plan-status', rabiStatusLocales))
  // Keep the store owned by the same effect as the slot contribution.
  ctx.effect(() => {
    const statusStore = createPlanStatusStore()
    const release = ctx.slots.inject('sidebar.workspaces.session.badges', () => ctx.slots.register({
      name: 'sidebar.workspaces.session.badges', id: 'rabi-plan-status', order: 30, locale: 'rabi-plan-status',
      inject: () => ({ statusStore }),
    }, RabiPlanStatusBadge))
    return () => { release(); statusStore.dispose() }
  })
}
