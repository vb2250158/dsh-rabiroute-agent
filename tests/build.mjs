import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
await mkdir(new URL('lib/', root), { recursive: true })

// Generated from RabiRoute apps/rabi-agent/lib/computer-image-view.mjs (MIT).
// Update the upstream pin when refreshing this exact public SDK snapshot.
const sdkModule = 'computer-image-view.mjs'
const sdkDigest = '7b560ce59b3a0f93599f933f18aec08c5e9ec9b9a381ca25997c0a3915775cb1'
// Git and Windows checkouts may use different newlines. Copy source bytes unchanged.
const sdkHash = bytes => createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex')
await mkdir(new URL('src/vendor/', root), { recursive: true })
await mkdir(new URL('lib/vendor/', root), { recursive: true })
const vendoredModule = new URL('src/vendor/' + sdkModule, root)
if (process.env.RABI_AGENT_SDK_SOURCE_ROOT) {
  const upstream = await readFile(resolve(process.env.RABI_AGENT_SDK_SOURCE_ROOT, 'lib', sdkModule))
  if (sdkHash(upstream) !== sdkDigest) throw new Error('Rabi Agent SDK image-view source does not match its pinned hash.')
  await writeFile(vendoredModule, upstream)
}
const sdkBytes = await readFile(vendoredModule)
if (sdkHash(sdkBytes) !== sdkDigest) throw new Error('Generated Rabi Agent SDK image-view snapshot changed. Refresh it from the pinned public source.')
await copyFile(vendoredModule, new URL('lib/vendor/' + sdkModule, root))
await copyFile(new URL('src/vendor/RabiRoute-LICENSE.txt', root), new URL('lib/vendor/RabiRoute-LICENSE.txt', root))

await copyFile(new URL('src/native-hooks.js', root), new URL('lib/native-hooks.js', root))
await copyFile(new URL('src/hook-context-cache.js', root), new URL('lib/hook-context-cache.js', root))
await copyFile(new URL('src/host-control.js', root), new URL('lib/host-control.js', root))
for (const name of ['plan-advance.js', 'workspace-plan-delta.js', 'workspace-plans.js', 'plan-resources.js', 'plan-resources-install.js', 'plan-context.js', 'plan-events.js', 'plan-status.js', 'workspace-skills.js', 'index.js', 'media-output.js', 'computer-format.js', 'connection.js', 'plan-panel.js', 'locate-agent.js', 'speech.js', 'speech-asr.js', 'message-mode.js', 'assistant-mode.js', 'assistant-preset.js']) await copyFile(new URL('src/' + name, root), new URL('lib/' + name, root))

// These dependency-free JS modules use the same loader envelope as the client bundle.
// Order matters: imports are stripped, so a module must precede its consumers.
const modules = ['message-envelope.js', 'client-locales.js', 'client-plan-locales.js', 'client-styles.js', 'plan-icon.js', 'client-plan.js', 'client-plan-status-store.js', 'client-plan-status.js', 'client-workspace-plan-store.js', 'client-plan-advance.js', 'client-workspace-plans.js', 'client-speech.js', 'client-question.js', 'client.js']
const sources = await Promise.all(modules.map(async name => {
  const source = await readFile(new URL('src/' + name, root), 'utf8')
  return source.replace(/^import [^\r\n]*\r?\n/gmu, '').replace(/^export /gmu, '')
}))
await writeFile(new URL('lib/client.js', root), `window.__ModuleLoader__.load({
  id: 'dsh-rabiroute-agent',
  factory: (require) => {
    const React = require('react')
    const { Tag, Tooltip, Button, Input, Menu, Modal, JsonBlock, projectUserText, fileSizeText, writeClipboard } = require('@deepseek-ai/dsh-client-ui-primitives')
${sources.join('\n')}
    return { inject, apply }
  },
})\n`)
