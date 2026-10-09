import * as React from 'react'
import { Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
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

/**
 * Strip at most two leading category tags only for a confirmed plan binding.
 * @param {string} title Original row title.
 * @param {boolean} bound Confirmed binding in the shared snapshot.
 * @returns {string} Display title, preserving empty-prefix-only titles.
 */
export function planSessionTitle(title, bound) {
  if (!bound) return title
  const compact = title.replace(/^(?:\s*\[[^\]\r\n]+\]){1,2}\s*/u, '')
  return compact.trim() ? compact : title
}

/** Display-only title; the original row title remains owned by the host. */
export function RabiPlanSessionTitle({ sessionId, title, useRabiPlanStatus }) {
  const snapshot = useRabiPlanStatus(snapshot => snapshot)
  return planSessionTitle(title, !!snapshot.entries[sessionId])
}

/** Persistent status label, keyed by the actual row rather than the selected session. */
export function RabiPlanStatusBadge({ sessionId, useRabiPlanStatus, t }) {
  const status = rowPlanStatus(sessionId, useRabiPlanStatus(snapshot => snapshot), t)
  if (!status) return null
  return React.createElement(Tooltip, { label: status.description },
    React.createElement('span', {
      'data-rabi-plan-status': sessionId, 'aria-label': status.description,
      style: { flexShrink: 0, maxWidth: '8em', fontSize: '10px' },
    }, status.entry.palette ? React.createElement('span', { style: {
      display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
      verticalAlign: 'middle', whiteSpace: 'nowrap', borderRadius: '999px', padding: '1px 6px', lineHeight: '15px',
      border: '1px solid color-mix(in srgb, ' + status.entry.palette.accent + ' 42%, var(--dsw-alias-border-l4))',
      background: 'color-mix(in srgb, ' + status.entry.palette.accent + ' 18%, var(--dsw-alias-bg-layer-2))',
      color: 'var(--dsw-alias-label-primary)',
    } }, status.label) : React.createElement(Tag, { tone: status.entry.conflict ? 'warning' : 'neutral' }, status.label)))
}

/** Register reversible root-scoped row views sharing one request scheduler.
 * @param {object} ctx Client plugin context.
 */
export function applyRabiPlanStatus(ctx) {
  ctx.effect(() => ctx.locale.register('rabi-plan-status', rabiStatusLocales))
  ctx.effect(() => {
    const statusStore = createPlanStatusStore()
    const register = (name, view) => ctx.slots.inject(name, () => ctx.slots.register({
      name, id: 'dsh-rabiroute-agent:plan-status', order: 30, locale: 'rabi-plan-status',
      inject: () => ({ hooks: { rabiPlanStatus: statusStore } }),
    }, view))
    const releaseBadge = register('sidebar.session.row.badges', RabiPlanStatusBadge)
    const releaseTitle = register('sidebar.session.row.title', RabiPlanSessionTitle)
    return () => { releaseTitle(); releaseBadge(); statusStore.dispose() }
  })
}
