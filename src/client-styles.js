/** Local geometry uses the active theme's semantic color tokens. */
export const rabiClientStyles = {
  row: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', minWidth: 0 },
  stack: { display: 'grid', gap: '8px', maxWidth: '100%', minWidth: 0 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', minWidth: 0 },
  sender: { maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'start', height: 'auto', minHeight: '28px' },
  bubble: { padding: '10px 14px', borderRadius: '16px', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0 },
  attachments: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '8px', minWidth: 0 },
  file: { display: 'grid', gap: '4px', padding: '8px 12px', border: '1px solid var(--dsw-alias-line-primary)', borderRadius: '10px', maxWidth: '100%', overflowWrap: 'anywhere' },
  muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', overflowWrap: 'anywhere' },
  actions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' },
  raw: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '65vh', overflow: 'auto', color: 'var(--dsw-alias-label-primary)' },
}
