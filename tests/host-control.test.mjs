import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createHostController, discoverHost, readHostStatus, readManagerEndpoint } from '../src/host-control.js'

const ready = async () => ({ ok: true, body: JSON.stringify({ health: { state: 'healthy', live: true, requiredReady: true } }) })

test('endpoint hints require versioned loopback identity and never execute the Host', async t => {
  const f = await fixture(t)
  const hint = { schemaVersion: 1, managerBaseUrl: 'http://127.0.0.1:12345', applicationGenerationId: 'generation', managerInstanceId: 'instance' }
  for (const patch of [{}, { schemaVersion: 0 }, { managerInstanceId: '' }, { managerBaseUrl: 'https://example.org' }, { managerBaseUrl: 'http://user:password@localhost:12345' }]) {
    await writeFile(path.join(f.root, 'manager-endpoint.json'), JSON.stringify({ ...hint, ...patch }))
    const result = await readManagerEndpoint(f.config)
    assert.equal(result !== null, Object.keys(patch).length === 0)
  }
})
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rabi-host-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = path.join(root, 'RabiRouteHost.exe')
  await writeFile(executable, 'fixture; never executed')
  const config = { hostExecutable: executable, hostHistoryFile: path.join(root, 'local', 'host.json') }
  const deps = { platform: 'win32', env: {}, runningHosts: async () => [], runStatus: async () => ({ ok: true, state: 'stopped' }), managerStatus: ready }
  return { root, executable, config, deps }
}

test('an inspected Host is remembered and rediscovered after explicit configuration is removed', async t => {
  const f = await fixture(t)
  assert.equal((await readHostStatus(f.config, undefined, f.deps)).state, 'stopped')
  assert.equal(JSON.parse(await readFile(f.config.hostHistoryFile, 'utf8')).executable, f.executable)
  assert.equal((await discoverHost({ ...f.config, hostExecutable: '' }, undefined, f.deps)).executable, f.executable)
})

test('the exact running Host can be discovered without scanning directories', async t => {
  const f = await fixture(t)
  assert.equal((await discoverHost({ ...f.config, hostExecutable: '' }, undefined, { ...f.deps, runningHosts: async () => [f.executable] })).executable, f.executable)
})

test('stopped, missing and unavailable installations have distinct states and inspection never starts a process', async t => {
  const f = await fixture(t); let launches = 0
  const controller = createHostController(f.config, { ...f.deps, launch: async () => { launches++; return { pid: 1 } } })
  assert.equal((await controller.inspect()).state, 'stopped'); assert.equal(launches, 0)
  await rm(f.executable)
  assert.equal((await controller.inspect()).state, 'not-found')
  await mkdir(f.executable)
  assert.equal((await createHostController(f.config, { ...f.deps, runStatus: async () => { throw Error('protocol failure') } }).inspect()).state, 'unavailable')
})

test('a start click only activates a verified stopped Host and concurrent clicks share one launch', async t => {
  const f = await fixture(t); let launches = 0
  const controller = createHostController(f.config, { ...f.deps, launch: async file => { assert.equal(file, f.executable); launches++; return { pid: 42 } } })
  const results = await Promise.all([controller.start(), controller.start()])
  assert.equal(launches, 1); assert.equal(results[0].state, 'starting'); assert.equal(results[0].launchAccepted, true)
})

test('running and starting Hosts are never restarted by the start action', async t => {
  const f = await fixture(t)
  const deps = { ...f.deps, runStatus: async () => ({ ok: true, state: 'degraded', managerBaseUrl: 'http://rabi.invalid' }), launch: async () => assert.fail('must not restart') }
  assert.equal((await createHostController(f.config, deps).start()).state, 'ready')
  assert.equal((await createHostController(f.config, { ...deps, managerStatus: async () => ({ ok: true, body: JSON.stringify({ health: { live: true, requiredReady: false } }) }) }).inspect()).state, 'unavailable')
})

test('launch refusal is not reported as a started Host', async t => {
  const f = await fixture(t)
  const result = await createHostController(f.config, { ...f.deps, launch: async () => { throw Error('denied') } }).start()
  assert.equal(result.state, 'unavailable'); assert.equal(result.reason, 'host-start-failed'); assert.equal(result.launchAccepted, undefined)
})

test('malformed or unrelated executable locations cannot be activated', async t => {
  const f = await fixture(t)
  assert.equal((await discoverHost({ ...f.config, hostExecutable: path.join(f.root, 'unrelated.exe') }, undefined, f.deps)).executable, '')
  await mkdir(path.dirname(f.config.hostHistoryFile), { recursive: true }); await writeFile(f.config.hostHistoryFile, '{invalid')
  assert.equal((await createHostController(f.config, f.deps).inspect()).state, 'stopped')
  assert.equal(JSON.parse(await readFile(f.config.hostHistoryFile, 'utf8')).executable, f.executable)
})
