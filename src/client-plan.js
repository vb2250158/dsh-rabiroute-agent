/** Client half: the Rabi plan panel, drawn by Rabi's own WebGUI inside the right Sidebar. */
import * as React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { RABI_PLAN_NS, rabiPlanLocales } from './client-plan-locales.js'
import { rabiClientStyles } from './client-styles.js'

/**
 * The plan panel is a thin frame, never a second plan renderer.
 *
 * Which plan a session is bound to, what that plan contains and how it looks all stay
 * Rabi's business: this module asks the Host's same-origin route which single plan the
 * session is bound to, then frames Rabi's own view of that plan. Nothing here reads a
 * plan, caches one, or draws one — a missing binding, an unresolved binding or an
 * unreachable Manager is reported as such rather than filled in from local state.
 */

/** The tab type's kind, and the id its body registers under. */
export const RABI_PLAN_KIND = 'rabi-plan'
export const RABI_PLAN_TAB_ID = 'dsh-rabiroute-agent/plan'
/** The Host route answering the binding question; same origin, so no CORS policy is needed. */
export const RABI_PLAN_PANEL_PATH = '/rabiroute/plan-panel'

/**
 * Sessions whose panel was already auto-opened once. Auto-opening is a courtesy
 * for a session the user just entered; repeating it on every switch back would
 * keep re-opening a column the user closed on purpose.
 */
const rabiPlanAutoOpened = new Set()

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
  // More than one bound plan is Rabi's own error state; the panel reports it rather
  // than choosing one, and names them so the fix is obvious.
  if (data?.reason === 'multiple-plans') return t('planMultiplePlans', {
    count: String(data.planCount ?? ''),
    titles: (Array.isArray(data.planTitles) ? data.planTitles : []).join(' / '),
  })
  if (data?.reason === 'unrouted') return t('planNoRoute', { roleId: String(data.roleId || '') })
  if (data?.reason === 'no-session') return t('planNoSession')
  return t('planUnreachable', { error: String(data?.message || data?.reason || 'unknown') })
}

/**
 * The tab body: Rabi's plan page for this session's bound persona, in a frame.
 * @param props - framework props carrying the session identity and plan copy.
 */
export function RabiPlanBody({ sessionId, t }) {
  const [state, setState] = React.useState({ phase: 'loading' })
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    const controller = new AbortController()
    let active = true
    setState({ phase: 'loading' })
    readRabiPlanPanelState(sessionId, controller.signal)
      .then(data => {
        if (!active) return
        setState({ phase: data.available ? 'ready' : 'empty', data })
      })
      .catch(error => {
        if (!active) return
        setState({ phase: 'empty', data: { available: false, reason: 'unreachable', message: error instanceof Error ? error.message : String(error) } })
      })
    return () => { active = false; controller.abort() }
  }, [sessionId, attempt])

  const reload = React.useCallback(() => { setAttempt(value => value + 1) }, [])

  if (state.phase === 'loading') {
    return React.createElement('div', { style: rabiClientStyles.planNotice }, t('loading'))
  }
  if (state.phase === 'ready') {
    return React.createElement('div', { style: rabiClientStyles.planFrameBox },
      React.createElement('iframe', { key: state.data.url, src: state.data.url, title: t('frameTitle'), style: rabiClientStyles.planFrame }))
  }
  return React.createElement('div', { style: rabiClientStyles.planNotice },
    React.createElement('div', null, rabiPlanEmptyText(state.data, t)),
    // The hint repeats the rule the panel obeys: no cached plan is ever shown in Rabi's place.
    React.createElement('div', { style: rabiClientStyles.muted }, t('planUnreachableHint')),
    React.createElement('div', { style: rabiClientStyles.planActions },
      React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: reload }, t('reload')),
      state.data?.url ? React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: () => { try { window.open(state.data.url, '_blank', 'noopener') } catch { /* a blocked popup is not an error worth reporting */ } } }, t('openExternal')) : null))
}

/**
 * The session-header entry: shown only while the session is bound to a Rabi
 * persona, and it opens the panel the first time that binding is seen.
 * @param props - framework props plus the panel-opening callback from `inject`.
 */
export function RabiPlanLauncher({ sessionId, t, openRabiPlanTab }) {
  const [state, setState] = React.useState({ phase: 'hidden' })
  // The callback is held in a ref so a re-created inject face cannot re-run the read.
  const open = React.useRef(openRabiPlanTab)
  open.current = openRabiPlanTab
  React.useEffect(() => {
    const controller = new AbortController()
    let active = true
    readRabiPlanPanelState(sessionId, controller.signal)
      .then(data => {
        if (!active || !data.available) return
        setState({ phase: 'ready' })
        if (rabiPlanAutoOpened.has(sessionId)) return
        try {
          open.current()
          // Only a successful open counts: a column that was not mounted yet must
          // stay eligible, so the next render can still open it.
          rabiPlanAutoOpened.add(sessionId)
        } catch {
          // Opening can refuse while the session's panel is not mounted; the
          // button remains, so the user can open it deliberately.
        }
      })
      .catch(() => { if (active) setState({ phase: 'hidden' }) })
    return () => { active = false; controller.abort() }
  }, [sessionId])

  if (state.phase !== 'ready') return null
  return React.createElement(Button, { size: 'sm', variant: 'ghost', title: t('launcherHint'), onClick: () => { try { open.current() } catch { /* the sidebar reports its own refusal */ } } }, t('launcher'))
}
