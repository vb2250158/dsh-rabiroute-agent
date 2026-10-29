import { execFile, spawn } from 'node:child_process'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const fail = (kind, cause) => Object.assign(new Error(kind, { cause }), { kind })
const budget = config => config.hostStatusTimeoutMs ?? 3000
const historyFile = (config, env) => config.hostHistoryFile || path.join(env.DSH_HOME || path.join(homedir(), '.dsh'), 'plugins', 'dsh-rabiroute-agent', 'host-location.json')

async function run(executable, args, timeout, signal) {
  return new Promise((resolve, reject) => execFile(executable, args, { windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 1048576, signal }, (error, stdout) => error ? reject(error) : resolve(stdout)))
}

/** Discover only configured, remembered, standard-install and currently running Host paths; never scan disks. */
export async function discoverHost(config, signal, dependencies = {}) {
  const env = dependencies.env ?? process.env
  const platform = dependencies.platform ?? process.platform
  const exists = dependencies.access ?? access
  const candidates = [config.hostExecutable, env.DSH_RABI_HOST_EXECUTABLE].filter(Boolean)
  let remembered = false
  let rememberedExecutable = ''
  let historyIssue = null
  try {
    const saved = JSON.parse(await readFile(historyFile(config, env), 'utf8'))
    if (saved.version === 1 && typeof saved.executable === 'string') { candidates.push(saved.executable); remembered = true; rememberedExecutable = saved.executable }
    else historyIssue = fail('host-location-unavailable')
  } catch (error) {
    if (error.code !== 'ENOENT') historyIssue = fail('host-location-unavailable', error)
  }
  if (platform === 'win32' && env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'RabiRoute', 'RabiRouteHost.exe'))
  const pick = async values => {
    for (const value of [...new Set(values)]) {
      if (typeof value !== 'string' || !path.isAbsolute(value) || path.basename(value).toLowerCase() !== 'rabiroutehost.exe') continue
      signal?.throwIfAborted()
      try { await exists(value); return path.resolve(value) }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw fail('host-location-unavailable', error) }
    }
    return ''
  }
  let executable = await pick(candidates)
  if (!executable && platform === 'win32') {
    const list = dependencies.runningHosts ?? (async () => {
      const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='RabiRouteHost.exe'\" | Select-Object -ExpandProperty ExecutablePath | ConvertTo-Json -Compress"], budget(config), signal)
      return output.trim() ? JSON.parse(output) : []
    })
    const running = await list(signal)
    executable = await pick(typeof running === 'string' ? [running] : Array.isArray(running) ? running : [])
  }
  if (!executable && historyIssue) throw historyIssue
  return { executable, remembered, rememberedExecutable }
}

/** Read the Host-published endpoint hint. Verified callers compare live /meta; unrestricted local Agents use the hint directly. */
export async function readManagerEndpoint(config, signal) {
  try {
    const { executable } = await discoverHost(config, signal)
    if (!executable) return null
    const hint = JSON.parse(await readFile(path.join(path.dirname(executable), 'manager-endpoint.json'), 'utf8'))
    if (hint.schemaVersion !== 1 || typeof hint.managerBaseUrl !== 'string'
      || typeof hint.applicationGenerationId !== 'string' || !hint.applicationGenerationId.trim()
      || typeof hint.managerInstanceId !== 'string' || !hint.managerInstanceId.trim()) return null
    const url = new URL(hint.managerBaseUrl)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return { managerBaseUrl: url.origin, applicationGenerationId: hint.applicationGenerationId, managerInstanceId: hint.managerInstanceId }
  } catch (error) {
    signal?.throwIfAborted()
    return null // A missing or stale hint falls back to the official Host status protocol.
  }
}

/** Query the official Host protocol and remember a verified executable in machine-local adapter data. */
export async function readHostStatus(config, signal, dependencies = {}) {
  const location = await discoverHost(config, signal, dependencies)
  if (!location.executable) throw fail(location.remembered ? 'host-location-missing' : 'host-not-found')
  let descriptor
  try {
    const output = await (dependencies.runStatus ?? ((executable, callerSignal) => run(executable, ['--command', 'status', '--json'], budget(config), callerSignal)))(location.executable, signal)
    descriptor = typeof output === 'string' ? JSON.parse(output) : output
    if (!descriptor || typeof descriptor.state !== 'string' || typeof descriptor.ok !== 'boolean') throw new Error('Invalid Host status')
  } catch (error) { throw fail('host-status-unavailable', error) }
  let locationRemembered = true
  try {
    if (location.rememberedExecutable === location.executable) return { ...descriptor, hostExecutable: location.executable, locationRemembered }
    const file = historyFile(config, dependencies.env ?? process.env)
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = file + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify({ version: 1, executable: location.executable }) + '\n', { mode: 0o600 })
    await rename(temporary, file)
  } catch (error) { locationRemembered = false } // Location history is a cache; a failed save must not break a live Manager.
  return { ...descriptor, hostExecutable: location.executable, locationRemembered }
}

function launch(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--command', 'activate'], { cwd: path.dirname(executable), windowsHide: true, detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve({ pid: child.pid }) })
  })
}

function managerReady(result) {
  if (!result?.ok) return false
  try {
    const meta = JSON.parse(result.body)
    return meta.health?.live === true && meta.health?.requiredReady === true && ['healthy', 'degraded'].includes(meta.health?.state)
  } catch (error) { return false } // Invalid wire metadata is unavailable, not a successful connection.
}

/** Host lifecycle adapter. Starting is explicit and acknowledged as starting, never as Manager readiness. */
export function createHostController(config, dependencies = {}) {
  let pendingStart = null
  const inspect = async signal => {
    let descriptor
    try { descriptor = await readHostStatus(config, signal, dependencies) }
    catch (error) {
      signal?.throwIfAborted()
      if (config.managerBaseUrl && dependencies.managerStatus) {
        const remote = await dependencies.managerStatus(signal)
        if (managerReady(remote)) return { state: 'ready', installed: false, canStart: false }
      }
      return { state: ['host-not-found', 'host-location-missing'].includes(error.kind) ? 'not-found' : 'unavailable', installed: error.kind === 'host-status-unavailable', canStart: false, reason: error.kind ?? 'host-status-unavailable' }
    }
    const base = { installed: true, canStart: true, locationRemembered: descriptor.locationRemembered }
    if (descriptor.state === 'stopped') return { ...base, state: 'stopped' }
    if (!descriptor.managerBaseUrl) return { ...base, state: descriptor.state === 'starting' ? 'starting' : 'unavailable' }
    const result = await dependencies.managerStatus(signal, descriptor)
    if (!managerReady(result)) return { ...base, state: descriptor.state === 'starting' ? 'starting' : 'unavailable' }
    return { ...base, state: 'ready' }
  }
  return {
    inspect,
    async start(signal) {
      if (pendingStart) return pendingStart
      const operation = async () => {
        const current = await inspect(signal)
        if (current.state !== 'stopped') return current
        const location = await discoverHost(config, signal, dependencies)
        if (!location.executable) return { state: 'not-found', installed: false, canStart: false }
        try {
          const result = await (dependencies.launch ?? launch)(location.executable)
          return { state: 'starting', installed: true, canStart: false, launchAccepted: true, processId: result.pid }
        } catch (error) { return { state: 'unavailable', installed: true, canStart: true, reason: 'host-start-failed' } }
      }
      pendingStart = operation()
      try { return await pendingStart } finally { pendingStart = null }
    },
  }
}
