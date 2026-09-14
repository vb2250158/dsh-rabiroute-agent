import { copyFile, mkdir } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
await mkdir(new URL('lib/', root), { recursive: true })
for (const name of ['index.js', 'connection.js']) await copyFile(new URL('src/' + name, root), new URL('lib/' + name, root))
