import path from 'node:path'
import { managerRequest } from './connection.js'

const PROVIDER = 'rabiroute-workspace'

/** Normalize absolute workspace identities without resolving relative paths against the DSH host. */
export function workspaceIdentity(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  let text = value.trim().replaceAll('\\', '/')
  if (text.startsWith('//?/UNC/')) text = '//' + text.slice(8)
  else if (text.startsWith('//?/')) text = text.slice(4)
  if (/^[a-z]:\//i.test(text) || text.startsWith('//')) return path.win32.normalize(text).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()
  return text.startsWith('/') ? path.posix.normalize(text).replace(/\/$/, '') || '/' : ''
}

/** Use readable invocation names; normalized collisions share one complete entry. */
function skillName(roleId, skillId) {
  const readable = [roleId, skillId].map(value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'skill').join('-')
  return 'rabi-' + readable
}

/** Contribute persona skills through the official cwd-sensitive registry; Rabi owns all binding and skill data. */
export function createWorkspaceSkillProvider(config, control, dependencies = {}) {
  const ttl = config.workspaceSkillCacheMs ?? 30000
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 2147483647) throw new Error('workspaceSkillCacheMs must be an integer between 1 and 2147483647.')
  const request = dependencies.request ?? ((pathname, signal) => managerRequest(config, pathname, {}, signal))
  let cached, pending, expires = 0, timer
  control.signal.addEventListener('abort', () => { clearTimeout(timer); cached = undefined }, { once: true })
  async function read(pathname) {
    control.signal.throwIfAborted()
    const response = await request(pathname, control.signal)
    control.signal.throwIfAborted()
    if (!response.ok) throw new Error('Rabi workspace skills request failed: ' + pathname + ' HTTP ' + response.statusCode)
    return JSON.parse(response.body)
  }
  async function refresh() {
    const gateways = await read('/api/gateways')
    if (!Array.isArray(gateways)) throw new Error('Rabi gateways must be an array.')
    const bindings = new Map()
    for (const gateway of gateways) {
      if (gateway.enabled === false || typeof gateway.agentRoleId !== 'string' || !gateway.agentRoleId) continue
      for (const adapter of gateway.agentAdapters ?? []) {
        const state = gateway.agentStates?.[adapter]
        const workspace = workspaceIdentity(state?.monitorThreadCwd || state?.monitorProjectPath)
        if (!workspace) continue
        if (!bindings.has(workspace)) bindings.set(workspace, new Set())
        bindings.get(workspace).add(gateway.agentRoleId)
      }
    }
    control.signal.throwIfAborted()
    cached = { bindings, catalogs: new Map() }
    expires = Date.now() + ttl
    clearTimeout(timer)
    timer = setTimeout(() => { cached = undefined; control.invalidate() }, ttl)
    timer.unref?.()
    return cached
  }
  async function loadRole(roleId) {
    const result = await read('/api/roles/' + encodeURIComponent(roleId) + '/skills')
    if (!Array.isArray(result.data)) throw new Error('Rabi skill catalog must be an array.')
    const candidates = result.data.filter(skill => skill.status === 'active').map(skill => {
      if (typeof skill.id !== 'string' || !skill.id || typeof skill.summary !== 'string' || typeof skill.title !== 'string') throw new Error('Invalid Rabi skill metadata.')
      const locator = { roleId, skillId: skill.id }
      const keywords = Array.isArray(skill.keywords) ? skill.keywords.filter(word => typeof word === 'string').join(', ') : ''
      return { name: skillName(roleId, skill.id), description: '[' + roleId + '] ' + skill.title + ': ' + skill.summary + (keywords ? ' (' + keywords + ')' : ''),
        whenToUse: keywords,
        invocation: { modelInvocable: true, userInvocable: true }, source: 'rabiroute', provider: PROVIDER,
        resourceBase: { kind: 'opaque', description: 'Rabi persona ' + roleId + ', skill ' + skill.id }, rank: 600, locator }
    })
    return candidates
  }
  async function snapshot(signal) {
    signal?.throwIfAborted()
    control.signal.throwIfAborted()
    let result = cached
    if (!result || Date.now() >= expires) {
      if (!pending) pending = refresh().finally(() => { pending = undefined })
      result = await pending
    }
    signal?.throwIfAborted()
    control.signal.throwIfAborted()
    return result
  }
  async function candidatesFor(snapshot, cwd) {
    const roles = [...(snapshot.bindings.get(workspaceIdentity(cwd)) ?? [])]
    const candidates = (await Promise.all(roles.map(role => {
      if (!snapshot.catalogs.has(role)) snapshot.catalogs.set(role, loadRole(role).catch(error => { snapshot.catalogs.delete(role); throw error }))
      return snapshot.catalogs.get(role)
    }))).flat()
    const groups = new Map()
    for (const candidate of candidates) {
      const group = groups.get(candidate.name)
      if (group) group.push(candidate)
      else groups.set(candidate.name, [candidate])
    }
    return [...groups.values()].map(group => ({
      ...group[0],
      description: group.map(item => item.description).join('\n'),
      whenToUse: [...new Set(group.map(item => item.whenToUse).filter(Boolean))].join(', '),
      resourceBase: { kind: 'opaque', description: group.map(item => item.resourceBase.description).join('; ') },
      locator: group.map(item => item.locator),
    }))
  }
  return {
    name: PROVIDER,
    async list(options = {}) {
      if (!workspaceIdentity(options.cwd)) return []
      return candidatesFor(await snapshot(options.signal), options.cwd)
    },
    async get(candidate, options = {}) {
      const current = (await candidatesFor(await snapshot(options.signal), options.cwd)).find(item => item.name === candidate.name)
      if (!current) return undefined
      const bodies = await Promise.all(current.locator.map(async ({ roleId, skillId }) => {
        const result = await read('/api/roles/' + encodeURIComponent(roleId) + '/skills/' + encodeURIComponent(skillId))
        if (result.data?.status !== 'active' || result.data?.id !== skillId) return undefined
        if (typeof result.data.content !== 'string') throw new Error('Rabi skill body must be Markdown text.')
        return { roleId, skillId, content: result.data.content }
      }))
      options.signal?.throwIfAborted()
      const active = bodies.filter(Boolean)
      if (!active.length) return undefined
      const { rank, locator, ...summary } = current
      const content = active.length === 1 ? active[0].content : active.map(item => '# [' + item.roleId + '] ' + item.skillId + '\n\n' + item.content).join('\n\n---\n\n')
      return { ...summary, content }
    },
  }
}
