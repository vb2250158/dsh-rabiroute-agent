import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'

/** Hash the complete session/persona/workspace/source identity in a fixed order. */
export const hookCacheKey = scope => createHash('sha256').update(JSON.stringify([scope.sessionId, scope.roleId, scope.cwd, scope.source])).digest('hex')
/** Keep configured connection credentials out of persisted cache metadata. */
export const hookCacheSource = config => createHash('sha256').update(JSON.stringify([config.managerBaseUrl || '', config.hostExecutable || process.env.DSH_RABI_HOST_EXECUTABLE || '', config.hostHistoryFile || ''])).digest('hex')

/** Private, bounded snapshots of confirmed Hook context; never a write receipt or tool decision. */
export function createHookContextCache(config, { clock = Date.now, warn = () => {} } = {}) {
  const file = config.hookContextCacheFile || path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'plugins/dsh-rabiroute-agent/hook-context-cache.json')
  if (!path.isAbsolute(file)) throw new Error('hookContextCacheFile must be absolute')
  const maxAge = config.hookContextCacheMaxAgeMs ?? 86400000
  const maxBytes = config.hookContextCacheMaxBytes ?? 2097152
  const maxEntries = config.hookContextCacheMaxEntries ?? 64
  const entryBytes = Math.min(262144, maxBytes)
  if (!Number.isInteger(maxAge) || maxAge < 1000 || maxAge > 2592000000
    || !Number.isInteger(maxBytes) || maxBytes < 4096 || maxBytes > 16777216
    || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 512) throw new Error('Invalid Hook context cache limits')
  const entries = new Map()
  let writing = Promise.resolve()
  let ready
  const load = () => ready ??= (async () => {
    try {
      const parent = await lstat(path.dirname(file))
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Hook cache parent must be a regular directory')
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Invalid Hook context cache file')
      const stored = JSON.parse(await readFile(file, 'utf8'))
      if (stored.version !== 1 || !Array.isArray(stored.entries) || stored.entries.length > maxEntries) throw new Error('Invalid Hook context cache version or entries')
      for (const value of stored.entries) {
        if (!value || typeof value.scope?.sessionId !== 'string' || typeof value.scope.roleId !== 'string'
          || typeof value.scope.cwd !== 'string' || typeof value.scope.source !== 'string'
          || !Number.isFinite(value.at) || value.full !== true || !Array.isArray(value.contexts)
          || !value.contexts.length || value.contexts.length > 8 || value.contexts.some(text => typeof text !== 'string')
          || Buffer.byteLength(JSON.stringify(value)) > entryBytes) continue
        entries.set(hookCacheKey(value.scope), value)
      }
    } catch (error) { if (error.code !== 'ENOENT') warn('Rabi Hook context cache could not be read: %s', error.message) }
  })()
  const persist = () => {
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
    let snapshot = JSON.stringify({ version: 1, entries: [...entries.values()] })
    while (Buffer.byteLength(snapshot) > maxBytes && entries.size) {
      entries.delete(entries.keys().next().value)
      snapshot = JSON.stringify({ version: 1, entries: [...entries.values()] })
    }
    writing = writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const parent = await lstat(path.dirname(file))
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Hook cache parent must be a regular directory')
      const temporary = file + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temporary, snapshot, { flag: 'wx', mode: 0o600 })
        await rename(temporary, file)
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
    }).catch(error => warn('Rabi Hook context cache could not be saved: %s', error.message))
  }
  return {
    async get(scope) {
      await load()
      const value = entries.get(hookCacheKey(scope))
      if (!value || clock() < value.at || clock() - value.at > maxAge) return null
      return { at: value.at, text: value.contexts.join('\n\n'), key: hookCacheKey(scope) }
    },
    async remember(scope, text, full) {
      await load()
      const key = hookCacheKey(scope), previous = entries.get(key)
      if (full && !text.trim()) { entries.delete(key); persist(); return }
      if (!full && (!previous || clock() < previous.at || clock() - previous.at > maxAge)) return
      let contexts = full ? [text] : [...previous.contexts]
      if (!full && text.trim() && !contexts.includes(text)) contexts.push(text)
      if (contexts.length > 8) contexts = [contexts[0], ...contexts.slice(-7)]
      const value = { scope: { ...scope }, at: full ? clock() : previous.at, full: true, contexts }
      if (Buffer.byteLength(JSON.stringify(value)) > entryBytes) {
        if (full) { entries.delete(key); persist() }
        return
      }
      entries.delete(key); entries.set(key, value); persist()
    },
    async forget(sessionId, roleId, source) {
      await load()
      for (const [key, value] of entries) if (value.scope.sessionId === sessionId && value.scope.roleId === roleId && value.scope.source === source) entries.delete(key)
      persist()
    },
    async flush() { if (ready) await ready; await writing },
  }
}
