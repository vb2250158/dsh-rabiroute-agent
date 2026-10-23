// DSH_SOURCE_ROOT names the rc.3 source checkout whose public services are exercised.
import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sourceRoot = process.env.DSH_SOURCE_ROOT
if (!sourceRoot) throw new Error('DSH_SOURCE_ROOT must name the rc.3 source checkout.')
await mkdir('.tmp-tests', { recursive: true })
const output = resolve('.tmp-tests/preset-rc3.mjs')
await build({ stdin: { contents: `export { Context } from '@deepseek-ai/cordis'; export { default as SystemPrompt } from '@deepseek-ai/dsh-system-prompt'; export { default as Tools } from '@deepseek-ai/dsh-tools'; export * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'; export { createScope, bindScopeParent, scopeTarget } from '@deepseek-ai/dsh-scope'; export * as message from './lib/message-mode.js'; export * as assistant from './lib/assistant-mode.js'; export { rabiAssistantPreset } from './lib/assistant-preset.js'; export { RABIROUTE_AGENT_TOOL_NAMES, internals } from './lib/index.js';`, resolveDir: process.cwd(), loader: 'ts' }, outfile: output, tsconfig: resolve(sourceRoot, 'tsconfig.base.json'), bundle: true, platform: 'node', format: 'esm', target: 'es2022' })
const { Context, SystemPrompt, Tools, NativeExecutor, createScope, bindScopeParent, scopeTarget, message, assistant, rabiAssistantPreset, RABIROUTE_AGENT_TOOL_NAMES, internals } = await import(pathToFileURL(output))

for (const [label, mode, names] of [['message', message, RABIROUTE_AGENT_TOOL_NAMES], ['assistant', assistant, assistant.RABI_ASSISTANT_TOOL_NAMES]]) {
  test(`real rc.3 ${label} preset uses native execution and keeps scoped restrictions and final guards`, async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(Tools)
      // Another preset's executor must not override this preset's explicit selection.
      await ctx.plugin(Object.assign(inner => inner.tools.setExecutor({ describe: () => ({ schemas: [] }), execute: () => { throw new Error('sibling executor must not run') } }), { inject: ['tools'] }))
      let preset, child
      const presetKey = { id: 'preset' }, agent = { id: 'agent', session: { id: 'test-session', header: { cwd: 'C:/fixture' } } }
      await ctx.plugin(Object.assign(inner => { preset = createScope(inner, presetKey); child = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
      bindScopeParent(agent, presetKey)
      agent.ctx = child.ctx
      let forbidden = 0
      const definition = name => ({ name, description: name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: async () => { if (!names.includes(name)) forbidden++; return 'ok' } })
      const calls = []
      for (const tool of internals.toolDefinitions({ managerBaseUrl: 'http://localhost:12345' }, {
        fetch: async (url, init) => {
          calls.push({ url, method: init.method })
          return new Response(JSON.stringify(url.endsWith('/meta') ? { health: { state: 'healthy', live: true, requiredReady: true }, applicationGenerationId: 'test', managerInstanceId: 'test' } : { ok: true }))
        },
      })) ctx.tools.register(tool)
      for (const name of [...names.filter(name => !RABIROUTE_AGENT_TOOL_NAMES.includes(name)), 'read_file']) ctx.tools.register(definition(name))
      const nativeRow = rabiAssistantPreset.plugins.find(row => row.name === '@deepseek-ai/dsh-tool-executor-native')
      await preset.ctx.plugin(NativeExecutor)
      const modeFiber = preset.ctx.plugin(mode)
      await modeFiber
      assert.ok(nativeRow, 'portable preset must select its native executor explicitly')
      await ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
      const assembled = await ctx.systemPrompt.assemble({ scope: agent, agent })
      assert.deepEqual(assembled.tools.map(tool => tool.name).sort(), [...names].sort())
      const run = async (name, args = {}) => (await ctx.tools.execute({ calls: [{ type: 'tool-call', id: 'call', name, arguments: JSON.stringify(args) }], agent, signal: new AbortController().signal })).results[0].result
      assert.equal((await run('rabiroute_agent_threads', { requestJson: JSON.stringify({ action: 'list' }) })).isError, false)
      assert.equal((await run('rabiroute_manager_api', { method: 'GET', path: '/api/roles/fixture/persona-document' })).isError, false)
      assert.ok(calls.some(call => call.url.endsWith('/api/roles/fixture/persona-document')))
      if (label === 'assistant') assert.equal((await run('web_search')).isError, false)
      assert.equal((await run('read_file')).isError, true)
      child.ctx.tools.register(definition('late_scoped'))
      child.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })
      assert.equal((await run('late_scoped')).isError, true)
      assert.equal(forbidden, 0)
      assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), [...names, 'read_file'].sort())
      await modeFiber.dispose()
      assert.equal((await run('late_scoped')).isError, false)
      assert.equal(forbidden, 1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
}
