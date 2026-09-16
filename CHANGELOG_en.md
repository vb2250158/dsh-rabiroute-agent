# Changelog

English | [简体中文](CHANGELOG.md)

## Unreleased

- Clarify Rabi shared business ownership and DSH local adaptation, with common contracts reusable by Codex and other Agents.
- Add standalone envelope parser source and synthetic format tests without runtime registration; preserve original text, body whitespace and fallback without executing reply JSON.
- Record the unreleased scope of sender headers, original-message viewing and session navigation. UI integration first evaluates public plugin replacement and ordinary-message compatibility without changing historical records; it is not connected or deployed.

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
