import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWorkspaceSkillProvider } from '../lib/workspace-skills.js'

test('built provider participates in the real DSH registry, expiry and disposal', { skip: !process.env.DSH_SOURCE_ROOT }, async () => {
  const root = process.env.DSH_SOURCE_ROOT
  const skillRoot = path.join(root, 'packages/skill/skill')
  const require = createRequire(path.join(skillRoot, 'package.json'))
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
  const { SkillRegistry } = await import(pathToFileURL(path.join(skillRoot, 'lib/index.js')))
  const { apply: applySkillTool } = await import(pathToFileURL(path.join(root, 'packages/skill/tool-skill/lib/index.js')))
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  let workspace = 'C:/Example/Game'
  const dispose = ctx.skills.registerProvider(control => createWorkspaceSkillProvider({ workspaceSkillCacheMs: 30 }, control, {
    request: async pathname => ({ ok: true, body: JSON.stringify(pathname === '/api/gateways'
      ? [{ agentRoleId: 'Builder', agentAdapters: ['dsh'], agentStates: { dsh: { monitorThreadCwd: workspace } } }]
      : { data: pathname.endsWith('/skills')
        ? [{ id: 'build', title: 'Build', summary: 'Check builds', status: 'active' }]
        : { id: 'build', status: 'active', content: '# Build\nRun the build.' } }) }),
  }))
  try {
    const [skill] = await ctx.skills.list({ cwd: workspace })
    assert.equal(skill.provider, 'rabiroute-workspace')
    assert.equal((await ctx.skills.get(skill.name, { cwd: workspace })).content, '# Build\nRun the build.')
    const listeners = []
    let tool
    applySkillTool({ skills: ctx.skills, tools: { register(value) { tool = value }, get() { return tool } }, on(name, listener) { listeners.push(listener) } })
    const agent = { session: { header: { cwd: workspace }, surface: { nodes: [] }, seq: 0 } }
    const signal = new AbortController().signal
    const loaded = await tool.execute({ name: skill.name }, { agent, signal })
    assert.equal(loaded.content, '# Build\nRun the build.')
    const catalog = await listeners[1]({ agent, signal }, async () => ({ kind: 'continue', messages: [] }))
    assert.deepEqual(catalog.messages[0].source, { kind: 'skill-catalog', form: 'catalog', entries: [{ name: skill.name, description: '[Builder] Build: Check builds' }] })
    const invoked = await listeners[0]({ agent, signal, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '/' + skill.name }] }] }, async () => ({ kind: 'continue', messages: [] }))
    assert.equal(invoked.messages[0].source.kind, 'skill-invocation')
    assert.match(invoked.messages[0].content[0].text, /Run the build/)
    assert.deepEqual(await ctx.skills.list({ cwd: 'C:/Example/Other' }), [])
    workspace = 'C:/Example/Other'
    await delay(45)
    assert.deepEqual(await ctx.skills.list({ cwd: 'C:/Example/Game' }), [])
    assert.equal((await ctx.skills.list({ cwd: workspace })).length, 1)
  } finally { dispose() }
  assert.deepEqual(await ctx.skills.list({ cwd: workspace }), [])
})
