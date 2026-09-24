English | [简体中文](EMBEDDED-PLAN.md)

# Plans inside a session

Panel URLs include `embedAgent=dsh` and the current session as `embedSession`. Compatible Rabi Web versions hide plan guidance and exclude the current session from linked Agents in embedded pages. Other bindings remain visible, and empty lists are hidden. Standalone Rabi pages retain their plan controls. These parameters only control presentation; they do not replace permissions or binding validation.

Returning to a session immediately reuses its verified binding and page address; opening other sessions does not evict them. A browser reload restores plan identities and a credential-free origin from session storage, then reconciles in the background; credential-bearing URLs are not stored. Plan events reconcile only affected sessions. If reconciliation fails, the last verified page remains visible with a stale notice. Rabi Web still renders the panel: it immediately shows a browser-session snapshot, then conditionally updates it by view revision.
