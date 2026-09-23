import * as React from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

const advanceCopy = {
  zh: { settings: '推进设置', check: '检查推进', close: '关闭', loading: '加载中…', retry: '重试', rule: '状态规则', save: '保存', saved: '已保存', enabled: '自动推进', startup: '启动后检查', events: '数据变化和会话结束后检查', due: '检查到期计划', on: '开启', off: '关闭', prompt: '推进提示词', inspect: '只检查与回写', continue: '继续已授权工作', changed: '计划有新变化', feedback: '收到新反馈', dueCondition: '计划到期', cooldown: '冷却时间（分钟）', maxRuns: '每个步骤最多推进次数', run: '推进选中项', next: '检查下一页', select: '选择', preview: '查看提示词', eligible: '可推进', role: '人格', empty: '没有符合规则的计划', pending: '正在处理…', error: '操作失败', inherited: '未启用状态规则', accepted: '已接收', skipped: '已跳过', uncertain: '结果待核对', rule_disabled: '规则未开启', inactive_plan: '计划已暂停或结束', binding_mismatch: '绑定不匹配', automation_disabled: '自动推进未开启', missing_current_step: '缺少当前步骤', approval_gate: '等待审批答复，只能检查', waiting_feedback: '等待新反馈', not_due: '尚未到期', delivery_uncertain: '上次投递结果待核对', already_consumed: '该变化已处理', cooldownReason: '冷却中', step_limit: '本步骤已达推进上限', session_running: '会话正在运行', session_unavailable: '会话暂不可用', session_reserved: '会话正在派发', changed_since_check: '计划已变化，请重新检查' },
  en: { settings: 'Advance settings', check: 'Check advancement', close: 'Close', loading: 'Loading…', retry: 'Retry', rule: 'Status rule', save: 'Save', saved: 'Saved', enabled: 'Automatic advancement', startup: 'Check after startup', events: 'Check changes and completed turns', due: 'Check due plans', on: 'On', off: 'Off', prompt: 'Status prompt', inspect: 'Inspect and update only', continue: 'Continue authorized work', changed: 'Plan changed', feedback: 'New feedback', dueCondition: 'Plan is due', cooldown: 'Cooldown (minutes)', maxRuns: 'Maximum runs per step', run: 'Advance selected', next: 'Check next page', select: 'Select', preview: 'Preview prompt', eligible: 'Ready', role: 'Persona', empty: 'No matching plans', pending: 'Working…', error: 'Operation failed', inherited: 'Status rule disabled', accepted: 'Accepted', skipped: 'Skipped', uncertain: 'Outcome uncertain', rule_disabled: 'Rule disabled', inactive_plan: 'Paused or terminal', binding_mismatch: 'Binding mismatch', automation_disabled: 'Automation disabled', missing_current_step: 'Missing current step', approval_gate: 'Approval gate: inspect feedback only', waiting_feedback: 'Waiting for feedback', not_due: 'Not due', delivery_uncertain: 'Previous delivery uncertain', already_consumed: 'Already consumed', cooldownReason: 'Cooling down', step_limit: 'Step run limit reached', session_running: 'Session running', session_unavailable: 'Session unavailable', session_reserved: 'Dispatch in progress', changed_since_check: 'Plan changed; check again' },
}
const defaultAdvanceRule = () => ({ enabled: false, prompt: '', action: 'inspect', condition: 'changed', cooldownMinutes: 10, maxRunsPerStep: 3 })
async function advanceCall(cwd, roleId, action, body, signal) {
  const response = await fetch('/rabiroute/plan-advance?' + new URLSearchParams({ cwd, roleId, action }), { signal, cache: 'no-store', ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  const value = await response.json()
  if (!response.ok || value.code !== 0) throw new Error(value.message || 'HTTP ' + response.status)
  return value.data
}

/** Settings and preview are projections of the persona-owned API, never local policy storage. */
export function RabiAdvanceDialog({ cwd, roleIds, mode, t: parentT, onClose }) {
  const t = key => (parentT('close') === '关闭' ? advanceCopy.zh : advanceCopy.en)[key] || key
  const [roleId, setRoleId] = React.useState(roleIds[0] || '')
  const [reload, setReload] = React.useState(0)
  const [data, setData] = React.useState(null), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false)
  const [selected, setSelected] = React.useState([]), [expanded, setExpanded] = React.useState(''), [saved, setSaved] = React.useState(false)
  React.useEffect(() => {
    const controller = new AbortController(); setData(null); setError(''); setSelected([]); setSaved(false)
    advanceCall(cwd, roleId, mode, mode === 'check' ? {} : undefined, controller.signal).then(setData).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [cwd, roleId, mode, reload])
  const action = async fn => { setBusy(true); setError(''); setSaved(false); try { await fn() } catch (e) { setError(e.message) } finally { setBusy(false) } }
  const toggle = (label, value, onChange, disabled = false) => React.createElement(Button, { size: 'sm', disabled: busy || disabled, 'aria-pressed': value, onClick: () => { setSaved(false); onChange(!value) } }, label + ' · ' + t(value ? 'on' : 'off'))
  const update = (key, patch) => { setSaved(false); setData(old => ({ ...old, policy: { ...old.policy, rules: { ...old.policy.rules, [key]: { ...defaultAdvanceRule(), ...old.policy.rules[key], ...patch } } } })) }
  const reason = key => t(key === 'cooldown' ? 'cooldownReason' : key)
  return React.createElement(Modal, { open: true, title: t(mode), closeLabel: t('close'), onClose, className: 'rabi-advance-dialog' },
    React.createElement('div', { style: { display: 'grid', gap: 10, minWidth: 0 }, 'data-rabi-advance': mode },
      React.createElement('style', null, '.rabi-advance-dialog{width:min(760px,calc(100vw - 40px))}.rabi-advance-dialog textarea{box-sizing:border-box;width:100%;min-height:120px;background:var(--dsw-alias-bg-base);color:inherit;border:1px solid var(--dsw-alias-border-l4);border-radius:6px;padding:8px}'),
      roleIds.length > 1 ? React.createElement('div', { style: { display: 'flex', gap: 6 } }, ...roleIds.map(id => React.createElement(Button, { key: id, size: 'sm', disabled: busy, 'aria-pressed': id === roleId, onClick: () => setRoleId(id) }, id))) : React.createElement('span', null, t('role') + ': ' + roleId),
      error ? React.createElement('div', { role: 'alert' }, t('error') + ': ' + error) : null,
      !data ? error ? React.createElement(Button, { size: 'sm', onClick: () => setReload(value => value + 1) }, t('retry')) : React.createElement('div', { role: 'status' }, t('loading')) : mode === 'settings' ? React.createElement(React.Fragment, null,
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, ...['enabled', 'startup', 'events', 'due'].map(key => React.createElement(React.Fragment, { key }, toggle(t(key), data.policy[key], value => setData(old => ({ ...old, policy: { ...old.policy, [key]: value } })))))),
        React.createElement('div', { style: { maxHeight: '52vh', overflow: 'auto', display: 'grid', gap: 8 } }, ...data.statuses.filter(status => status.state === 'enabled').map(status => {
          const rule = data.policy.rules[status.key] || defaultAdvanceRule(); const inactive = status.terminal || status.key === data.roles.paused
          return React.createElement('section', { key: status.key, style: { border: '1px solid var(--dsw-alias-border-l4)', borderLeft: '3px solid ' + status.palette.accent, borderRadius: 6, padding: 8 } },
            React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'space-between' } },
              React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: () => setExpanded(expanded === status.key ? '' : status.key) }, status.label),
              toggle(t('rule'), rule.enabled, enabled => update(status.key, { enabled }), inactive)),
            expanded === status.key ? React.createElement('div', { style: { display: 'grid', gap: 8 } },
              React.createElement('textarea', { value: rule.prompt, disabled: busy || inactive, 'aria-label': status.label + ' ' + t('prompt'), placeholder: t('prompt'), onChange: event => update(status.key, { prompt: event.target.value }) }),
              React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, ...['inspect', 'continue'].map(id => React.createElement(Button, { key: id, size: 'sm', disabled: busy || inactive, 'aria-pressed': rule.action === id, onClick: () => update(status.key, { action: id }) }, t(id)))),
              React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, ...['changed', 'feedback', 'due'].map(id => React.createElement(Button, { key: id, size: 'sm', disabled: busy || inactive, 'aria-pressed': rule.condition === id, onClick: () => update(status.key, { condition: id }) }, t(id === 'due' ? 'dueCondition' : id)))),
              ...[['cooldownMinutes', 'cooldown'], ['maxRunsPerStep', 'maxRuns']].map(([key, label]) => React.createElement('label', { key }, t(label), React.createElement(Input, { type: 'number', disabled: busy || inactive, value: String(rule[key]), 'aria-label': t(label), onChange: event => update(status.key, { [key]: Number(event.target.value) }) })))) : null)
        })),
        React.createElement(Button, { disabled: busy, onClick: () => action(async () => { const result = await advanceCall(cwd, roleId, 'settings', { policy: data.policy, revision: data.revision }); setData(result); setSaved(true) }) }, t(busy ? 'pending' : 'save')),
        saved ? React.createElement('div', { role: 'status' }, t('saved')) : null,
        data.runtimeErrors && Object.keys(data.runtimeErrors).length ? React.createElement('div', { role: 'alert' }, Object.values(data.runtimeErrors).join('\n')) : null
      ) : React.createElement(React.Fragment, null,
        React.createElement('div', { style: { maxHeight: '55vh', overflow: 'auto', display: 'grid', gap: 8 } }, ...(data.items || []).map(item => React.createElement('article', { key: item.planId, style: { padding: 8, border: '1px solid var(--dsw-alias-border-l4)', borderRadius: 6 } },
          React.createElement('div', null, item.title || item.planId),
          React.createElement('div', null, item.label, ' · ', item.eligible ? t('eligible') : reason(item.reason || item.state)),
          item.eligible ? toggle(t('select'), selected.includes(item.planId), value => setSelected(old => value ? [...old, item.planId] : old.filter(id => id !== item.planId))) : null,
          item.prompt ? React.createElement('details', null, React.createElement('summary', null, t('preview')), React.createElement('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, item.prompt)) : null)),
          !data.items?.length ? React.createElement('div', null, t('empty')) : null),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          React.createElement(Button, { disabled: busy || !selected.length, onClick: () => action(async () => {
            const items = data.items.filter(item => selected.includes(item.planId)); const result = await advanceCall(cwd, roleId, 'run', { planIds: items.map(item => item.planId), expected: Object.fromEntries(items.map(item => [item.planId, item.fingerprint])) });
            setData({ items: result.items.map(item => ({ ...items.find(old => old.planId === item.planId), ...item, eligible: false })), nextCursor: data.nextCursor }); setSelected([])
          }) }, t(busy ? 'pending' : 'run')),
          React.createElement(Button, { disabled: busy || !data.nextCursor, onClick: () => action(async () => { setData(await advanceCall(cwd, roleId, 'check', { cursor: data.nextCursor })); setSelected([]) }) }, t('next'))))))
}
