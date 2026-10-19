import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookContextCache, hookCacheSource } from '../src/hook-context-cache.js'

const scope = { sessionId: 'session', roleId: 'role', cwd: 'workspace', source: 'source' }
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hook-cache-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const config = { hookContextCacheFile: join(dir, 'cache.json'), ...options }
  return { config, cache: createHookContextCache(config, { clock: () => 10000 }) }
}

test('confirmed snapshots survive restart and isolate every identity dimension', async t => {
  const { config, cache } = await fixture(t)
  await cache.remember(scope, 'confirmed persona', true)
  await cache.remember(scope, 'confirmed prompt context', false)
  await cache.flush()
  const restored = createHookContextCache(config, { clock: () => 10001 })
  assert.equal((await restored.get(scope)).text, 'confirmed persona\n\nconfirmed prompt context')
  for (const key of Object.keys(scope)) assert.equal(await restored.get({ ...scope, [key]: 'other' }), null)
  assert.equal((await restored.get({ source: scope.source, cwd: scope.cwd, roleId: scope.roleId, sessionId: scope.sessionId })).text, (await cache.get(scope)).text)
  assert.doesNotMatch(hookCacheSource({ managerBaseUrl: 'http://user:secret@localhost/?token=private' }), /secret|private/)
})

test('deltas cannot create a snapshot or extend the base snapshot lifetime', async t => {
  const { config } = await fixture(t, { hookContextCacheMaxAgeMs: 1000 })
  let now = 10000
  const cache = createHookContextCache(config, { clock: () => now })
  await cache.remember(scope, 'delta without base', false)
  assert.equal(await cache.get(scope), null)
  await cache.remember(scope, 'base', true)
  now += 900
  await cache.remember(scope, 'delta', false)
  assert.equal((await cache.get(scope)).at, 10000)
  now += 101
  assert.equal(await cache.get(scope), null)
  await cache.remember(scope, 'late delta', false)
  assert.equal(await cache.get(scope), null)
  await cache.remember(scope, 'new base', true)
  assert.equal((await cache.get(scope)).text, 'new base')
  now = 1
  assert.equal(await cache.get(scope), null)
  await cache.flush()
})

test('empty full context and explicit unlink invalidate all workspaces of one binding', async t => {
  const { cache } = await fixture(t)
  await cache.remember(scope, 'base', true)
  await cache.remember({ ...scope, cwd: 'another' }, 'another workspace', true)
  await cache.remember({ ...scope, sessionId: 'other' }, 'other session', true)
  await cache.remember(scope, '', true)
  assert.equal(await cache.get(scope), null)
  await cache.forget(scope.sessionId, scope.roleId, scope.source)
  assert.equal(await cache.get({ ...scope, cwd: 'another' }), null)
  assert.equal((await cache.get({ ...scope, sessionId: 'other' })).text, 'other session')
  await cache.flush()
})

test('entry count, byte budget and retained deltas stay bounded on disk', async t => {
  const { config, cache } = await fixture(t, { hookContextCacheMaxEntries: 2, hookContextCacheMaxBytes: 4096 })
  for (const sessionId of ['one', 'two', 'three']) await cache.remember({ ...scope, sessionId }, 'base', true)
  assert.equal(await cache.get({ ...scope, sessionId: 'one' }), null)
  for (let i = 0; i < 20; i++) await cache.remember({ ...scope, sessionId: 'three' }, 'delta ' + i, false)
  const kept = (await cache.get({ ...scope, sessionId: 'three' })).text
  assert.match(kept, /^base/); assert.match(kept, /delta 19/); assert.doesNotMatch(kept, /delta 0\b/)
  await cache.remember(scope, 'old base', true)
  await cache.remember(scope, 'x'.repeat(5000), true)
  assert.equal(await cache.get(scope), null)
  await cache.flush()
  assert.ok((await stat(config.hookContextCacheFile)).size <= 4096)
})

test('relative files and linked parent directories cannot provide or overwrite snapshot content', async t => {
  assert.throws(() => createHookContextCache({ hookContextCacheFile: 'relative-cache.json' }), /absolute/)
  const { config } = await fixture(t)
  const target = join(config.hookContextCacheFile, '..', 'target')
  const link = join(config.hookContextCacheFile, '..', 'linked')
  await mkdir(target)
  const content = JSON.stringify({ version: 1, entries: [{ scope, at: 10000, full: true, contexts: ['linked private context'] }] })
  await writeFile(join(target, 'cache.json'), content)
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  const warnings = []
  const cache = createHookContextCache({ ...config, hookContextCacheFile: join(link, 'cache.json') }, { clock: () => 10000, warn: (...args) => warnings.push(args) })
  assert.equal(await cache.get(scope), null)
  await cache.remember(scope, 'replacement', true); await cache.flush()
  assert.equal(await readFile(join(target, 'cache.json'), 'utf8'), content)
  assert.equal(warnings.length, 2)
})

test('malformed, oversized and wrong-version files provide no context and recover on confirmed refresh', async t => {
  const { config } = await fixture(t, { hookContextCacheMaxBytes: 4096 })
  for (const content of ['{', 'x'.repeat(4097), JSON.stringify({ version: 99, entries: [] })]) {
    await writeFile(config.hookContextCacheFile, content)
    const warnings = []
    const cache = createHookContextCache(config, { clock: () => 10000, warn: (...args) => warnings.push(args) })
    assert.equal(await cache.get(scope), null)
    assert.equal(warnings.length, 1)
    await cache.remember(scope, 'recovered', true); await cache.flush()
    assert.match(await readFile(config.hookContextCacheFile, 'utf8'), /recovered/)
  }
})
