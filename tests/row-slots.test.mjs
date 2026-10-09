import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRowSlots } from '../scripts/check-row-slots.mjs'
test('upgrade check rejects a missing built row slot before installing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rabi-row-slots-'))
  const base = join(root, 'packages/client/ui-workspace')
  const contents = {
    'src/client/contract/slots.ts': 'sidebar.session.row.badges sidebar.session.row.title',
    'src/client/index.ts': 'sidebar.session.row.badges sidebar.session.row.title',
    'src/client/rows/Rows.tsx': "renderSlot('sidebar.session.row.badges', { sessionId: result.id }) renderSlot('sidebar.session.row.badges', { sessionId: node.id }) fallback: title",
    'lib/client.js': 'sidebar.session.row.badges',
  }
  try {
    for (const [file, text] of Object.entries(contents)) { await mkdir(join(base, file, '..'), { recursive: true }); await writeFile(join(base, file), text) }
    await assert.rejects(checkRowSlots(root), /lib.client.js.*sidebar.session.row.title/)
    await writeFile(join(base, 'lib/client.js'), 'sidebar.session.row.badges sidebar.session.row.title')
    await checkRowSlots(root)
  } finally { await rm(root, { recursive: true, force: true }) }
})
