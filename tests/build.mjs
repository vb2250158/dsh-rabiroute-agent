import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
await mkdir(new URL('lib/', root), { recursive: true })
for (const name of ['index.js', 'connection.js']) await copyFile(new URL('src/' + name, root), new URL('lib/' + name, root))

// These dependency-free JS modules use the same loader envelope as the client bundle.
const modules = ['message-envelope.js', 'client-locales.js', 'client-styles.js', 'client.js']
const sources = await Promise.all(modules.map(async name => {
  const source = await readFile(new URL('src/' + name, root), 'utf8')
  return source.replace(/^import [^\r\n]*\r?\n/gmu, '').replace(/^export /gmu, '')
}))
await writeFile(new URL('lib/client.js', root), `window.__ModuleLoader__.load({
  id: 'dsh-rabiroute-agent',
  factory: (require) => {
    const React = require('react')
    const { Button, Menu, Modal, JsonBlock, projectUserText, fileSizeText, writeClipboard } = require('@deepseek-ai/dsh-client-ui-primitives')
${sources.join('\n')}
    return { inject, apply }
  },
})\n`)
