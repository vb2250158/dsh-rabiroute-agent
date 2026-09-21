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
  const label = entry.conflict ? t('conflict') : entry.label || entry.status
  if (!label) return null
  return React.createElement(Tooltip, { label: t('plan') + ': ' + label + (snapshot.stale ? ' · ' + t('stale') : '') },
    React.createElement('span', { style: { flexShrink: 0, maxWidth: '8em', fontSize: '10px' }, 'data-rabi-plan-status': sessionId },
      entry.palette ? React.createElement('span', { style: {
        display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'middle',
        whiteSpace: 'nowrap', borderRadius: '999px', padding: '1px 6px', lineHeight: '15px',
        border: '1px solid color-mix(in srgb, ' + entry.palette.accent + ' 42%, var(--dsw-alias-border-l4))',
        background: 'color-mix(in srgb, ' + entry.palette.accent + ' 18%, var(--dsw-alias-bg-layer-2))',
        color: 'var(--dsw-alias-label-primary)',
      } }, label) : React.createElement(Tag, { tone: entry.conflict ? 'warning' : 'neutral' }, label)))
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
