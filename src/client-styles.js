/** Local geometry uses the active theme's semantic color tokens. */
export const rabiClientStyles = {
  source: { display: 'inline-block', maxWidth: '100%', minWidth: 0, verticalAlign: 'top', marginBottom: '4px', whiteSpace: 'normal' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', minWidth: 0 },
  sender: { maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'start', height: 'auto', minHeight: '28px' },
  muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', overflowWrap: 'anywhere' },
  raw: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '65vh', overflow: 'auto', color: 'var(--dsw-alias-label-primary)' },
  planDirectory: { flex: '0 0 auto', maxHeight: '35%', overflowY: 'auto', padding: '8px', borderBottom: '1px solid var(--dsw-alias-border-l4)' },
  planDirectoryItem: { display: 'flex', width: '100%', justifyContent: 'space-between', gap: '8px', height: 'auto', textAlign: 'left', padding: '8px' },
  planDirectoryTitle: { minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' },
  planDirectoryStatus: { flexShrink: 0, border: '1px solid', borderRadius: '999px', padding: '1px 6px', fontSize: '11px', color: 'var(--dsw-alias-label-primary)' },
  planFrameBox: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  // The frame fills the panel when the panel has a height, and never collapses to a
  // sliver when it does not: Rabi's own page needs a usable viewport either way.
  planFrame: { flex: '1 1 auto', width: '100%', minHeight: 0, border: 'none', background: 'var(--dsw-alias-bg-layer-1)' },
  planNotice: { display: 'grid', gap: '8px', padding: '12px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', overflowWrap: 'anywhere' },
  planActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  // The header entry is Rabi's own mark, so it drops the button's text padding for the
  // 28x28 icon form the primitives keep for icon-only controls.
  planLauncherButton: { padding: 0, width: '28px' },
  planLauncherIcon: { display: 'block', width: '16px', height: '16px', borderRadius: '3px' },
}
