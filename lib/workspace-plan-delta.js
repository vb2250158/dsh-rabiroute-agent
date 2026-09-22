import { createHash } from 'node:crypto'

const workspacePageHash = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url')

/** Return only changed rows and page metadata; the authoritative query owns membership and order. */
export function workspacePageDelta(page, params) {
  let known = []
  if (params.has('known')) {
    known = JSON.parse(params.get('known'))
    if (!Array.isArray(known) || known.length > 250 || known.some(value => typeof value !== 'string' || !/^[\w-]{43}$/.test(value))) throw new Error('Invalid page revisions.')
  }
  const versions = new Set(known)
  const { items, ...meta } = page
  const rows = items.map(item => ({ ...item, revision: workspacePageHash(item) }))
  const order = rows.map(item => item.revision)
  const orderRevision = workspacePageHash(order)
  const metaRevision = workspacePageHash(meta)
  return { items: rows.filter(item => !versions.has(item.revision)), orderRevision, metaRevision,
    ...(params.get('orderRevision') === orderRevision ? {} : { order }),
    ...(params.get('metaRevision') === metaRevision ? {} : { meta }) }
}
