import { copyFile, readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const sourceRoot = process.env.DSH_SOURCE_ROOT
if (!sourceRoot) throw new Error('Set DSH_SOURCE_ROOT to a built DeepSeek Harness checkout.')
const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const fixture = new URL('./auto-speech-browser.fixture.txt', import.meta.url)
const target = join(resolve(sourceRoot), 'apps/web/tests/local-rabi-auto-read.e2e.ts')
if (existsSync(target)) throw new Error('Local browser fixture already exists; it will not be overwritten.')
const contents = await readFile(fixture, 'utf8')
await copyFile(fixture, target)
try {
  execFileSync(process.execPath, [join(sourceRoot, 'node_modules/vitest/vitest.mjs'), 'run',
    '--config', 'vitest.web.config.ts', 'apps/web/tests/local-rabi-auto-read.e2e.ts'], {
    cwd: sourceRoot, windowsHide: true, stdio: 'inherit', timeout: 180000,
    env: { ...process.env, DSH_RABI_PLUGIN_ROOT: pluginRoot, DSH_SNAPSHOT: 'replay' },
  })
} finally {
  if (await readFile(target, 'utf8') === contents) await unlink(target)
  else throw new Error('Local browser fixture changed during testing and was retained.')
}
