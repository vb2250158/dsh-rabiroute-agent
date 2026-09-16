# Changelog

English | [简体中文](CHANGELOG.md)

## Unreleased

- Clarify Rabi shared business ownership and DSH local adaptation, with common contracts reusable by Codex and other Agents.
- Add standalone envelope parser source and synthetic format tests without runtime registration; preserve original text, body whitespace and fallback without executing reply JSON.
- Record the unreleased scope of sender headers, original-message viewing and session navigation. UI integration first evaluates public plugin replacement and ordinary-message compatibility without changing historical records; it is not connected or deployed.

## 0.2.1 — 2026-09-16

- **Correct the entry's visibility condition.** 0.2.0 gated the button on availability (a plan already bound), which hid the entry during the ordinary interval when a session is persona-bound but Rabi has not recorded a plan yet — precisely when an entry is wanted. It now appears whenever the session has a Rabi persona binding (the Host route returns a non-empty `roleId`), and stays hidden when `roleId` is empty (unbound, or Manager unreachable).
- **The entry is Rabi's icon button.** Taken from `RabiRoute/assets/rabiroute-icon.png`, downscaled to 64px and inlined into the client bundle (new `src/plan-icon.js`, ~4 KB) rather than fetched: the DSH client has no dependable URL for Rabi's static assets, and a fetch would blink an empty button. The icon-only control uses the button's 28×28 form, with `launcherHint` as both title and accessible name.
- **Auto-open still requires a bound plan**, so a bound session without one does not open an empty column; a manual click is not restricted.
- Closing is unchanged and now documented: closing and collapsing belong to DSH's right column, and a manual close is not undone by switching sessions because auto-open is deduplicated per session.
- Acceptance: 46 source tests pass (including new assertions for the icon and for a bound session with no plan still showing the entry); the DSH bundle is confirmed to carry the entry registration and the icon. Display in the running instance remains to be accepted.

## 0.2.0 — 2026-09-16

- Add a right-Sidebar "Rabi plan" panel: it opens once for a session bound to a Rabi plan, and the entry beside the session title reopens it at any time; the panel shows **the one plan bound to that session**, with no catalog, paging or memory panels.
- The binding criterion is Rabi's own rule, `plan.taskBinding.sessionId` (including the secretary binding); DSH introduces no second judgement. A session bound to several plans is reported and named rather than resolved by choosing, matching Rabi's own semantics.
- The panel neither re-draws nor caches a plan: the Host gains the same-origin read-only route `GET /rabiroute/plan-panel?sessionId=…`, which reads the session binding, pages through the role's current plan summaries to match the binding, maps the role to a route, and returns Rabi's single-plan address; Rabi's own interface renders the content.
- Every failure returns its own reason (`unbound` / `no-plan` / `multiple-plans` / `unrouted` / `no-session` / `unreachable`); an unavailable Manager reports only the reason and never a plan inferred from local data.
- The plan tab registers as an independent page type under this plugin's own id and takes over no existing tab type; Manager addresses are still discovered and identity-checked against `/meta` per operation.
- The Rabi side stays within its existing read-only interface: no Manager backend change, so shipping alongside it needs only the front-end Web hot patch (the plan page's `/routes/:id/plan/:planId` focus address). No plan body is read and the full catalog is never pulled.
- Acceptance so far: source tests on both sides (46 for this plugin, 302 for Rabi WebGUI) and read-only probes against a real Manager pass; end-to-end rendering of the single-plan view, plugin installation, DSH UI display and cross-machine sync remain unverified.

## 0.1.5 — 2026-09-14

- Align DSH tools with the current Codex/Manager contract using per-operation Host discovery, health and generation/instance checks; remove fixed-port defaults and prompt addresses.
- Add restricted version/idempotency headers, full response metadata, post-write identity checks and explicit uncertainty. Business requests are not automatically replayed.
- Add read-only health and sending-receipt queries, stricter paths/redirects, source-conflict validation and cancellation handling.
- Synchronize source and packaged entry in the build; add connection/failure regressions and remove unloaded legacy no-op invariant modules.
- Published a pinned commit and verified isolated installation through the official installer. The installed package passed dynamic Host discovery and read-only `/meta` checks. Production-profile installation remains subject to local transaction checks; the separate DSH Hook, real delivery and storage writes are outside this read-only acceptance.
