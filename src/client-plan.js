/** Client half: the Rabi plan panel, drawn by Rabi's own WebGUI inside the right Sidebar. */
import * as React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { RABI_PLAN_NS, rabiPlanLocales } from './client-plan-locales.js'
import { RABI_PLAN_ICON_DATA_URI } from './plan-icon.js'
import { rabiClientStyles } from './client-styles.js'

/**
 * The plan panel is a thin frame, never a second plan renderer.
 *
 * The Host resolves bound summaries. Multiple bindings render a directory; only
 * the selected plan mounts Rabi's detail page. Plan bodies remain owned by Rabi.
 */

/** The tab type's kind, and the id its body registers under. */
export const RABI_PLAN_KIND = 'rabi-plan'
export const RABI_PLAN_TAB_ID = 'dsh-rabiroute-agent/plan'
/** The Host route answering the binding question; same origin, so no CORS policy is needed. */
export const RABI_PLAN_PANEL_PATH = '/rabiroute/plan-panel'

const PANEL_VISIBILITY_PREFIX = 'dsh-rabiroute-agent:plan-visibility:'
const panelVisibility = new Map()
const panelSnapshots = new Map()
const panelListeners = new Map()
let panelEvents

function savedPanelVisibility(sessionId) {
  if (panelVisibility.has(sessionId)) return panelVisibility.get(sessionId)
  let value
  try { value = sessionStorage.getItem(PANEL_VISIBILITY_PREFIX + sessionId) } catch { /* Browser storage is optional. */ }
  if (value === 'open' || value === 'closed') panelVisibility.set(sessionId, value)
  return value
}

function savePanelVisibility(sessionId, value) {
  if (savedPanelVisibility(sessionId) === value) return
  panelVisibility.set(sessionId, value)
  try { sessionStorage.setItem(PANEL_VISIBILITY_PREFIX + sessionId, value) } catch { /* Memory still tracks this tab. */ }
}

/** Observe only the right panel's tab strip and expanded attribute, never the chat transcript. */
function watchPlanPanelVisibility(sessionId, title) {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const panel = document.querySelector('[data-sidebar-right-panel]')
  if (!panel) return () => {}
  let sawPlanTab = false
  const read = () => {
    if (!panel.isConnected) return
    const tab = Array.from(panel.querySelectorAll('[data-dockkit-tab]'))
      .find(node => node.querySelector('[data-dockkit-tab-title]')?.textContent === title)
    if (tab) sawPlanTab = true
    if (!sawPlanTab) return
    savePanelVisibility(sessionId,
      panel.hasAttribute('data-sidebar-right-open') && tab?.getAttribute('aria-selected') === 'true' ? 'open' : 'closed')
  }
  const observer = new MutationObserver(read)
  observer.observe(panel, { attributes: true, attributeFilter: ['data-sidebar-right-open', 'aria-selected'], childList: true, subtree: true })
  read()
  return () => observer.disconnect()
}

function panelSnapshot(sessionId) {
  return panelSnapshots.get(sessionId)
}

function invalidatePanelSnapshots(change = {}, notify = true) {
  for (const [sessionId, entry] of Array.from(panelSnapshots)) {
    if (panelSnapshots.get(sessionId) !== entry) continue
    const plans = entry.data?.plans || (entry.data ? [entry.data] : [])
    if (change.roleId && entry.data && !plans.some(plan => plan.roleId === change.roleId)) continue
    if (change.planId && entry.data?.available && !plans.some(plan => plan.planId === change.planId)) continue
    entry.dirty = true
    entry.revision = (entry.revision || 0) + 1
    if (notify) for (const listener of panelListeners.get(sessionId) || []) listener()
  }
}

function watchPanelSnapshot(sessionId, listener) {
  let listeners = panelListeners.get(sessionId)
  if (!listeners) { listeners = new Set(); panelListeners.set(sessionId, listeners) }
  listeners.add(listener)
  if (!panelEvents && typeof EventSource !== 'undefined') {
    panelEvents = new EventSource('/rabiroute/plan-events')
    panelEvents.addEventListener('changed', event => {
      try { invalidatePanelSnapshots(JSON.parse(event.data || '{}')) }
      catch { invalidatePanelSnapshots() }
    })
    panelEvents.addEventListener('error', () => { for (const entry of panelSnapshots.values()) entry.dirty = true })
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) panelListeners.delete(sessionId)
    if (!panelListeners.size) { panelEvents?.close(); panelEvents = undefined }
  }
}

async function cachedPanelState(sessionId) {
  let entry = panelSnapshot(sessionId)
  if (entry?.pending) return entry.pending
  if (entry && !entry.dirty && entry.data) return entry.data
  if (!entry) {
    entry = { data: null, pending: null, dirty: true, revision: 0 }
    panelSnapshots.set(sessionId, entry)
  }
  const revision = entry.revision
  entry.pending = readRabiPlanPanelState(sessionId).then(data => {
    entry.pending = null
    if (entry.revision !== revision) return cachedPanelState(sessionId)
    entry.data = data
    entry.dirty = false
    // An unbound session has no confirmed address to retain. A later binding
    // must be discovered from Rabi rather than an old empty response.
    if (!data.roleId && !data.plans?.some(plan => plan.roleId)) panelSnapshots.delete(sessionId)
    return data
  }).catch(error => {
    entry.pending = null
    entry.dirty = true
    if (!entry.data) panelSnapshots.delete(sessionId)
    throw error
  })
  return entry.pending
}

/**
 * Ask the Host which Rabi route this session's binding resolves to.
 * @param sessionId - the DSH session whose Rabi binding decides the target.
 * @param signal - aborts the read when the panel leaves the screen.
 * @returns the Host's panel state; a failure is reported, never thrown away.
 */
export async function readRabiPlanPanelState(sessionId, signal) {
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
export function rabiPlanTabDefinition(t) {
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
  if (data?.reason === 'unrouted') return t('planNoRoute', { roleId: String(data.roleId || '') })
  if (data?.reason === 'no-session') return t('planNoSession')
  return t('planUnreachable', { error: String(data?.message || data?.reason || 'unknown') })
}

/**
 * The tab body: Rabi's plan page for this session's bound persona, in a frame.
 * @param props - framework props carrying the session identity and plan copy.
 */
export function RabiPlanBody({ sessionId, t }) {
  const [state, setState] = React.useState(() => {
    const data = panelSnapshot(sessionId)?.data
    return data ? { sessionId, phase: data.available ? 'ready' : 'empty', data } : { sessionId, phase: 'loading' }
  })
  const [attempt, setAttempt] = React.useState(0)
  const [selection, setSelection] = React.useState(null)
  React.useEffect(() => {
    let active = true
    const cached = panelSnapshot(sessionId)?.data
    setState(cached ? { sessionId, phase: cached.available ? 'ready' : 'empty', data: cached } : { sessionId, phase: 'loading' })
    cachedPanelState(sessionId)
      .then(data => {
        if (!active) return
        setState({ sessionId, phase: data.available ? 'ready' : 'empty', data })
      })
      .catch(error => {
        if (!active) return
        const previous = panelSnapshot(sessionId)?.data
        setState(previous
          ? { sessionId, phase: previous.available ? 'ready' : 'empty', data: previous, stale: true }
          : { sessionId, phase: 'empty', data: { available: false, reason: 'unreachable', message: error instanceof Error ? error.message : String(error) } })
      })
    return () => { active = false }
  }, [sessionId, attempt])
  React.useEffect(() => watchPanelSnapshot(sessionId, () => setAttempt(value => value + 1)), [sessionId])

  const reload = React.useCallback(() => {
    const entry = panelSnapshot(sessionId)
    if (entry) { entry.dirty = true; entry.revision = (entry.revision || 0) + 1 }
    setAttempt(value => value + 1)
  }, [sessionId])

  const current = state.sessionId === sessionId ? state : (() => {
    const data = panelSnapshot(sessionId)?.data
    return data ? { sessionId, phase: data.available ? 'ready' : 'empty', data } : { sessionId, phase: 'loading' }
  })()
  if (current.phase === 'loading') {
    return React.createElement('div', { style: rabiClientStyles.planNotice }, t('loading'))
  }
  if (current.phase === 'ready') {
    const plans = current.data.plans || [current.data]
    const selected = plans.find(plan => selection?.sessionId === sessionId
      && plan.roleId === selection.roleId && plan.planId === selection.planId) || plans[0]
    return React.createElement('div', { style: rabiClientStyles.planFrameBox },
      current.stale ? React.createElement('div', { style: rabiClientStyles.planNotice }, t('planStale')) : null,
      plans.length > 1 ? React.createElement('nav', { 'aria-label': t('directory'), style: rabiClientStyles.planDirectory },
        React.createElement('div', { style: rabiClientStyles.planActions },
          React.createElement('strong', null, t('directoryCount', { count: plans.length })),
          React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: reload }, t('reload'))),
        plans.map(plan => React.createElement(Button, {
          key: JSON.stringify([plan.roleId, plan.planId]), size: 'sm', variant: 'ghost',
          style: { ...rabiClientStyles.planDirectoryItem, background: plan === selected ? 'var(--dsw-alias-bg-layer-2)' : undefined },
          'aria-current': plan === selected ? 'page' : undefined,
          onClick: () => setSelection({ sessionId, roleId: plan.roleId, planId: plan.planId }),
        }, React.createElement('span', { style: rabiClientStyles.planDirectoryTitle }, plan.planTitle || plan.planId),
        plan.planStatus ? React.createElement('span', { style: { ...rabiClientStyles.planDirectoryStatus,
          borderColor: plan.accent || 'var(--dsw-alias-border-l4)',
          background: plan.accent ? 'color-mix(in srgb, ' + plan.accent + ' 18%, var(--dsw-alias-bg-layer-2))' : undefined,
        } }, plan.planStatus) : null))) : null,
      selected.url ? React.createElement('iframe', { key: selected.url, src: selected.url, title: t('frameTitle'), style: rabiClientStyles.planFrame })
        : React.createElement('div', { style: rabiClientStyles.planNotice }, t('planNoRoute', { roleId: selected.roleId })))
  }
  return React.createElement('div', { style: rabiClientStyles.planNotice },
    React.createElement('div', null, rabiPlanEmptyText(current.data, t)),
    React.createElement('div', { style: rabiClientStyles.muted }, t(current.stale ? 'planStale' : 'planUnreachableHint')),
    React.createElement('div', { style: rabiClientStyles.planActions },
      React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: reload }, t('reload')),
      current.data?.url ? React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: () => { try { window.open(current.data.url, '_blank', 'noopener') } catch { /* a blocked popup is not an error worth reporting */ } } }, t('openExternal')) : null))
}

/**
 * The session-header entry: shown while the session is bound to a Rabi persona, and it
 * opens the panel the first time that binding is seen.
 *
 * Visibility turns on the **binding**, not on a plan already existing. Gating it on
 * availability hid the entry in exactly the case it was asked for, because a bound
 * session whose plan has not been recorded yet is the normal state between "Rabi bound
 * this session" and "Rabi attached a plan"; the panel is where that gets explained.
 * Auto-opening still requires a plan, so a bound-but-empty session does not open a
 * column that has nothing to show.
 * @param props - framework props plus the panel-opening callback from `inject`.
 */
export function RabiPlanLauncher({ sessionId, t, openRabiPlanTab, getRabiPanelView }) {
  const [state, setState] = React.useState(() => ({ sessionId, phase: panelSnapshot(sessionId)?.data?.roleId ? 'ready' : 'hidden' }))
  // The callback is held in a ref so a re-created inject face cannot re-run the read.
  const open = React.useRef(openRabiPlanTab)
  open.current = openRabiPlanTab
  const view = React.useRef(getRabiPanelView)
  view.current = getRabiPanelView
  const phase = state.sessionId === sessionId ? state.phase : panelSnapshot(sessionId)?.data?.roleId ? 'ready' : 'hidden'
  React.useEffect(() => phase === 'ready' ? watchPlanPanelVisibility(sessionId, t('tab')) : undefined, [sessionId, phase, t])
  React.useEffect(() => {
    let active = true
    cachedPanelState(sessionId)
      .then(data => {
        if (!active) return
        // A roleId is what "this session is bound to a Rabi persona" looks like from here.
        setState({ sessionId, phase: data.roleId ? 'ready' : 'hidden' })
        if (!data.roleId || !data.available || savedPanelVisibility(sessionId) === 'closed') return
        const current = view.current?.()
        if (current?.activeKind === RABI_PLAN_KIND) {
          savePanelVisibility(sessionId, current.expanded ? 'open' : 'closed')
          return
        }
        if (current?.activeKind) return
        try {
          open.current()
          savePanelVisibility(sessionId, 'open')
        } catch {
          // Opening can refuse while the session's panel is not mounted; the
          // button remains, so the user can open it deliberately.
        }
      })
      .catch(() => { if (active) setState({ sessionId, phase: panelSnapshot(sessionId)?.data?.roleId ? 'ready' : 'hidden' }) })
    return () => { active = false }
  }, [sessionId])
  React.useEffect(() => watchPanelSnapshot(sessionId, () => {
    // A changed binding needs the launcher to re-read; the body owns the visible refresh.
    cachedPanelState(sessionId).then(data => setState({ sessionId, phase: data.roleId ? 'ready' : 'hidden' }))
      .catch(() => setState({ sessionId, phase: panelSnapshot(sessionId)?.data?.roleId ? 'ready' : 'hidden' }))
  }), [sessionId])

  if (phase !== 'ready') return null
  // Rabi's own mark, carried in the bundle: the entry is the way back to a panel the
  // user closed, so it has to be recognisable at a glance and must not depend on a
  // fetch that could fail or flash.
  return React.createElement(Button, {
    size: 'sm', variant: 'ghost', style: rabiClientStyles.planLauncherButton,
    icon: React.createElement('img', {
      src: RABI_PLAN_ICON_DATA_URI, alt: '', width: 16, height: 16,
      style: rabiClientStyles.planLauncherIcon,
    }),
    'aria-label': t('launcherHint'), title: t('launcherHint'),
    onClick: () => { try { open.current(); savePanelVisibility(sessionId, 'open') } catch { /* the sidebar reports its own refusal */ } },
  })
}
