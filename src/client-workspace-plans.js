import * as React from 'react'
import { Button, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { RABI_PLAN_ICON_DATA_URI } from './plan-icon.js'

const workspacePlanLocales = {
  zh: { title: '工作区 Rabi 计划', close: '关闭', search: '搜索计划、关键字…', loading: '加载中…', empty: '没有匹配的计划', retry: '重试', next: '下一页', previous: '上一页', open: '打开会话', status: '状态', tag: '标签', sort: '排序', all: '全部', current: '当前', plans: '计划', archived: '已归档', view: '范围', updated: '最近更新', importance: '重要性', urgency: '紧急性', total: '个计划', error: '计划加载失败', stale: '计划已更新，正在刷新' },
  en: { title: 'Workspace Rabi plans', close: 'Close', search: 'Search plans and keywords…', loading: 'Loading…', empty: 'No matching plans', retry: 'Retry', next: 'Next', previous: 'Previous', open: 'Open session', status: 'Status', tag: 'Tag', sort: 'Sort', all: 'All', current: 'Current', plans: 'Plans', archived: 'Archived', view: 'View', updated: 'Updated', importance: 'Importance', urgency: 'Urgency', total: 'plans', error: 'Failed to load plans', stale: 'Plans changed; refreshing' },
}

async function workspacePlanRead(cwd, params, signal) {
  const query = new URLSearchParams({ cwd, ...params })
  const response = await fetch('/rabiroute/workspace-plans?' + query, { signal, cache: 'no-store' })
  const body = await response.json()
  if (!response.ok || body.code !== 0) throw new Error(body.message || 'HTTP ' + response.status)
  return body.data
}

function WorkspacePlanMenu({ label, options, value, onChange }) {
  const [open, setOpen] = React.useState(false)
  return React.createElement(Menu, { open, portal: true, onClose: () => setOpen(false),
    items: options.map(item => ({ id: item.id, label: item.label })),
    onSelect: id => { setOpen(false); onChange(id) },
    anchor: React.createElement(Button, { size: 'sm', variant: 'ghost', 'aria-label': label, onClick: () => setOpen(!open) }, options.find(item => item.id === value)?.label || label) })
}

/** The workspace dialog owns one cancellable page read and one event subscription while open. */
export function RabiWorkspacePlanDialog({ cwd, t, openPlan, openSession, onClose }) {
  const [query, setQuery] = React.useState('')
  const [filters, setFilters] = React.useState({ status: '', tag: '', sort: 'status', view: '' })
  const [cursors, setCursors] = React.useState([''])
  const [revision, setRevision] = React.useState(0)
  const [state, setState] = React.useState({ loading: true, data: null, error: '' })
  const [selection, setSelection] = React.useState(null)
  React.useEffect(() => {
    const stream = new EventSource('/rabiroute/plan-events')
    let timer
    const changed = () => { clearTimeout(timer); timer = setTimeout(() => { setCursors(['']); setRevision(n => n + 1) }, 200) }
    stream.addEventListener('changed', changed)
    stream.addEventListener('open', changed)
    return () => { clearTimeout(timer); stream.close() }
  }, [cwd])
  React.useEffect(() => {
    const controller = new AbortController()
    setState(old => ({ ...old, loading: true, error: '' }))
    const timer = setTimeout(() => {
      workspacePlanRead(cwd, { query, ...filters, cursor: cursors.at(-1) }, controller.signal)
        .then(data => { if (!controller.signal.aborted) setState({ loading: false, data, error: '' }) })
        .catch(error => { if (!controller.signal.aborted) setState(old => ({ ...old, loading: false, error: error.message })) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [cwd, query, filters, cursors, revision])
  const updateFilter = (key, value) => { setFilters(old => ({ ...old, [key]: value })); setCursors(['']) }
  const run = action => { try { action(); onClose() } catch (error) { setState(old => ({ ...old, error: error.message })) } }
  const menu = (key, options) => React.createElement(WorkspacePlanMenu, { key, label: t(key), options, value: filters[key], onChange: value => updateFilter(key, value) })
  const data = state.data
  return React.createElement(Modal, { open: true, title: t('title'), closeLabel: t('close'), onClose },
    React.createElement('div', { style: { width: 'min(660px, 75vw)', display: 'grid', gap: 10 }, 'data-rabi-workspace-plans': cwd },
      React.createElement(Input, { value: query, placeholder: t('search'), 'aria-label': t('search'), onChange: event => { setQuery(event.target.value); setCursors(['']) } }),
      React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        menu('view', ['', 'current', 'plans', 'archived'].map(id => ({ id, label: t(id || 'all') }))),
        menu('status', [{ id: '', label: t('status') }, ...(data?.facets.statuses || []).map(item => ({ id: item.status, label: item.label }))]),
        menu('tag', [{ id: '', label: t('tag') }, ...(data?.facets.tags || []).map(item => ({ id: item.tag, label: item.tag }))]),
        menu('sort', ['status', 'updated', 'importance', 'urgency'].map(id => ({ id, label: t(id) })))),
      state.error ? React.createElement('div', { role: 'alert' }, t('error') + ': ' + state.error, React.createElement(Button, { size: 'sm', onClick: () => setRevision(n => n + 1) }, t('retry'))) : null,
      state.loading ? React.createElement('div', { role: 'status' }, t('loading')) : null,
      React.createElement('div', { style: { maxHeight: '52vh', overflowY: 'auto', display: 'grid', gap: 8 }, 'aria-busy': state.loading },
        ...(data?.items || []).map(plan => React.createElement('article', { key: plan.roleId + '/' + plan.id, 'data-rabi-workspace-plan': plan.id,
          style: { padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l4)', borderLeft: '3px solid ' + plan.presentation.palette.accent, borderRadius: 8 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement(Button, { variant: 'ghost', size: 'sm', style: { flex: 1, minWidth: 0, justifyContent: 'flex-start', textAlign: 'left' }, onClick: () => run(() => openPlan(plan)) }, plan.title),
            React.createElement('span', { style: { fontSize: 11, whiteSpace: 'nowrap', padding: '2px 6px', borderRadius: 8, background: 'color-mix(in srgb, ' + plan.presentation.palette.accent + ' 18%, transparent)', border: '1px solid ' + plan.presentation.palette.accent } }, plan.presentation.label)),
          React.createElement('div', { style: { opacity: 0.8, fontSize: 12, margin: '4px 0' } }, plan.currentStep),
          React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => plan.sessions.length === 1 ? run(() => openSession(plan.sessions[0].id)) : setSelection(plan) }, t('open') + ' · ' + plan.sessions.map(session => session.title).join(' / ')))),
        !state.loading && !state.error && !data?.items.length ? React.createElement('div', null, t('empty')) : null),
      React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        React.createElement('span', null, (data?.total ?? 0) + ' ' + t('total')),
        React.createElement(Button, { size: 'sm', disabled: state.loading || cursors.length < 2, onClick: () => setCursors(old => old.slice(0, -1)) }, t('previous')),
        React.createElement(Button, { size: 'sm', disabled: state.loading || !data?.nextCursor, onClick: () => setCursors(old => [...old, data.nextCursor]) }, t('next'))),
      selection ? React.createElement(Modal, { open: true, title: t('open'), closeLabel: t('close'), onClose: () => setSelection(null) },
        ...selection.sessions.map(session => React.createElement(Button, { key: session.id, onClick: () => run(() => openSession(session.id)) }, session.title))) : null))
}

export function RabiWorkspacePlanLauncher({ cwd, t, openPlan, openSession }) {
  const [matched, setMatched] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    const controller = new AbortController()
    setMatched(false); setOpen(false)
    workspacePlanRead(cwd, { action: 'match' }, controller.signal).then(data => { if (!controller.signal.aborted) setMatched(data.matched) }).catch(() => {})
    return () => controller.abort()
  }, [cwd])
  if (!matched) return null
  return React.createElement('span', { onClick: event => event.stopPropagation(), 'data-rabi-workspace-launcher': cwd },
    React.createElement(Button, { size: 'sm', variant: 'ghost', 'aria-label': t('title'), title: t('title'), onClick: () => setOpen(true),
      icon: React.createElement('img', { src: RABI_PLAN_ICON_DATA_URI, alt: '', width: 16, height: 16 }) }),
    open ? React.createElement(RabiWorkspacePlanDialog, { cwd, t, openPlan, openSession, onClose: () => setOpen(false) }) : null)
}

function RabiWorkspacePlanDetail({ useTabInfo, t }) {
  const { tab } = useTabInfo()
  const url = tab.navigation.params?.url
  return url ? React.createElement('iframe', { src: url, title: t('title'), style: { width: '100%', height: '100%', border: 0 } }) : null
}

/** Public workspace action and page tab; no DOM lookup or durable session changes. */
export function applyWorkspacePlans(ctx) {
  const ns = 'rabi-workspace-plans', kind = 'rabi-workspace-plan', id = 'dsh-rabiroute-agent/workspace-plan'
  ctx.effect(() => ctx.locale.register(ns, workspacePlanLocales))
  ctx.effect(() => ctx.sidebarRightTabs.register({ id, kind, title: () => ctx.locale.bind(ns)('title') }))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id, locale: ns }, RabiWorkspacePlanDetail))
  ctx.slots.inject('sidebar.workspaces.workspace.actions', () => ctx.slots.register({ name: 'sidebar.workspaces.workspace.actions', id: 'rabi-workspace-plans', order: 20, locale: ns,
    inject: () => ({ openPlan: plan => ctx.sidebarRight.openTab(kind, { params: { url: plan.url } }), openSession: id => ctx.uiWorkspace.openSession(id) }),
  }, RabiWorkspacePlanLauncher))
}
