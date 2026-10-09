import * as React from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { createPlanStatusStore } from './client-plan-status-store.js'

const rabiStatusLocales = {
  zh: { conflict: '多个计划', stale: '缓存状态，等待刷新', plan: 'Rabi 计划状态' },
  en: { conflict: 'Multiple plans', stale: 'Cached status, awaiting refresh', plan: 'Rabi plan status' },
}

/** Row identity selects the Manager-owned status; the framework supplies its subscription hook. */
function rowPlanStatus(sessionId, snapshot, t) {
  const entry = snapshot.entries[sessionId]
  if (!entry) return null
  const label = entry.conflict ? t('conflict') : entry.label || entry.status
  if (!label) return null
  return { entry, label, description: t('plan') + ': ' + label + (snapshot.stale ? ' · ' + t('stale') : '') }
}

/** Fits the public 16px leading seat; the host's activity and interaction dots take precedence. */
export function RabiPlanStatusMarker({ sessionId, useRabiPlanStatus, t }) {
  const status = rowPlanStatus(sessionId, useRabiPlanStatus(snapshot => snapshot), t)
  if (!status) return null
  return React.createElement('span', {
    role: 'img', 'aria-label': status.description, title: status.description,
    'data-rabi-plan-status-marker': sessionId,
    style: {
      display: 'inline-block', width: '10px', height: '10px', boxSizing: 'border-box', flexShrink: 0,
      borderRadius: '3px', border: '1px solid currentColor',
      color: status.entry.palette?.accent || 'var(--dsw-alias-label-secondary)',
      background: status.entry.conflict ? 'currentColor' : 'transparent',
    },
  })
}

/** Full status in the row's existing hover card, including explicit cached-state information. */
export function RabiPlanStatusBadge({ sessionId, useRabiPlanStatus, t }) {
  const snapshot = useRabiPlanStatus(snapshot => snapshot)
  const status = rowPlanStatus(sessionId, snapshot, t)
  if (!status) return null
  const { entry, label, description } = status
  return React.createElement('div', {
    'data-rabi-plan-status': sessionId, 'aria-label': description,
    style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', fontSize: '12px' },
  },
  React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('plan')),
  entry.palette ? React.createElement('span', { style: {
    display: 'inline-block', maxWidth: '100%', overflowWrap: 'anywhere',
    borderRadius: '999px', padding: '1px 6px', lineHeight: '17px',
    border: '1px solid color-mix(in srgb, ' + entry.palette.accent + ' 42%, var(--dsw-alias-border-l4))',
    background: 'color-mix(in srgb, ' + entry.palette.accent + ' 18%, var(--dsw-alias-bg-layer-2))',
    color: 'var(--dsw-alias-label-primary)',
  } }, label) : React.createElement(Tag, { tone: entry.conflict ? 'warning' : 'neutral' }, label),
  snapshot.stale && React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('stale')))
}

/** Public root-scoped row seats share one reversible cache without activating listed sessions. */
export function applyRabiPlanStatus(ctx) {
  ctx.effect(() => ctx.locale.register('rabi-plan-status', rabiStatusLocales))
  ctx.effect(() => {
    const statusStore = createPlanStatusStore()
    const register = (name, view) => ctx.slots.inject(name, () => ctx.slots.register({
      name, id: 'dsh-rabiroute-agent:plan-status', order: 30, locale: 'rabi-plan-status',
      inject: () => ({ hooks: { rabiPlanStatus: statusStore } }),
    }, view))
    const releaseMarker = register('sidebar.session.row.leading', RabiPlanStatusMarker)
    const releaseHover = register('sidebar.session.row.hover', RabiPlanStatusBadge)
    return () => { releaseHover(); releaseMarker(); statusStore.dispose() }
  })
}
