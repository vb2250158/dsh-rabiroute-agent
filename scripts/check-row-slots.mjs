/** 检查常驻标签需要的宿主源码和浏览器构建产物。 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @param {string} root 宿主源码根目录。 @returns {Promise<void>} 接口缺失时拒绝。 */
export async function checkRowSlots(root) {
  const base = resolve(root, 'packages/client/ui-workspace')
  const requirements = {
    'src/client/contract/slots.ts': ['sidebar.session.row.badges', 'sidebar.session.row.title'],
    'src/client/index.ts': ['sidebar.session.row.badges', 'sidebar.session.row.title'],
    'src/client/rows/Rows.tsx': ["renderSlot('sidebar.session.row.badges', { sessionId: result.id })", "renderSlot('sidebar.session.row.badges', { sessionId: node.id })", 'fallback: title'],
    'lib/client.js': ['sidebar.session.row.badges', 'sidebar.session.row.title'],
  }
  for (const [file, values] of Object.entries(requirements)) {
    const source = await readFile(resolve(base, file), 'utf8')
    for (const value of values) if (!source.includes(value)) throw new Error('会话行接口缺失：' + file + ' / ' + value)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('用法：node scripts/check-row-slots.mjs <宿主源码根>')
  await checkRowSlots(process.argv[2])
  console.log('会话行标签源码与浏览器构建检查通过')
}
