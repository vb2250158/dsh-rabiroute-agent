# Changelog

English | [简体中文](CHANGELOG.md)

## 0.7.2 — 2026-09-20

- Mount the microphone as a flex item on the official custom-answer row, outside the overlapping `.field` grid cell, with a visible bordered icon.

## 0.7.0 — 2026-09-20

- Add a message-processing session preset limited to Rabi messaging, Agent sessions/task coordination and plan management; deny command/file access and other tool execution.
- Extend the Manager tool with persona discovery, persona messages and receipts; deny attachment reads/writes in message mode.
- Define a dedicated coordinator that delegates research, design and execution; include memory, plan, persona-skill and collaboration guidance with the current session identity while preserving Rabi business reads and memory maintenance.

## 0.6.2 — 2026-09-20

- Move voice input to a clickable microphone icon at the right edge of the official custom-answer field so the textarea no longer intercepts clicks.

## 0.6.1 — 2026-09-20

- Wait for the official question composer before wrapping, so the custom-branch label and microphone are not dropped by plugin order.
- Attach extras after the official textarea appears; only the official custom-answer field is enhanced.

## 0.6.0 — 2026-09-19

- Wrap the official `ask_user_question` card: label free text as "Your own branch" and add Rabi default-ASR voice input on that field.
- Add same-origin `POST /rabiroute/speech/asr` using the current default ASR (preloaded `faster-whisper/small` here) to transcribe browser WAV into the official controlled field. No model override, service start, or fake option clicks.
- Tests cover defaults, offline/missing ASR, invalid audio, cross-origin rejection and textarea fill. Live recording remains an installed-page check.

## 0.5.0 — 2026-09-19

- Replace queued host playback with a 24px browser mini player: indeterminate generation state, duplicate-click protection, play/pause, seeking and timestamps.
- Generate WAV with Rabi defaults, retain audio only in page memory and release it on unmount. Add speechTimeoutMs; restart DSH and refresh the page to update both endpoints.

## 0.4.1 — 2026-09-19

- Correct default TTS selection using the live service contract: `defaults.tts` identifies a provider; its `providers.tts` entry supplies the model. Send the provider/model pair and preserve concrete rejection details.

## 0.4.0 — 2026-09-19

- Adds a speaker action to read one finalized reply using Rabi's current default TTS. Offline services are reported without automatic startup; missing playback receipts remain uncertain without retries.
- Adds the same-origin speech adapter and tests for defaults, offline services, request validation, duplicate clicks and uncertain outcomes. Installed UI and audible playback acceptance remain pending.
- Speech accepts a live degraded Manager only when required capabilities and instance identity are verified, then checks TTS readiness separately. Other tools and plan interfaces retain full health requirements.

## 0.3.0 — 2026-09-17

- **"Locate Agent" now works for non-DSH sources.** A non-`dsh` `agentAdapter` used to throw "Navigation for this external Agent adapter is not supported", so a `codex` row rendered its header as a button that only reported an error when clicked. Adapters such as `codex` are now handed to RabiRoute to raise that client's window — the local DSH client does not hold that session at all, so deciding it here could only guess.
- Adds the same-origin route `POST /rabiroute/locate-agent`, carrying only `{ agentAdapter, threadId }`. Rabi declares no CORS policy for the DSH origin, so the browser cannot reach the Manager directly and the Host answers for it: it verifies `/meta` identity, then calls `POST /api/agent/threads` (`action=open`). Only those two fields travel; no message body and no credentials are proxied.
- A `dsh` source is unchanged: matched by full ID in the local catalog and selected in place, with no detour. An `agentAdapter` outside Rabi's supported set is refused before any request is sent, while Rabi's own rejection reason travels back verbatim instead of being rewritten into something vaguer.
- The folded row's locate hint now explains that DSH switches in place and other adapters are handed to RabiRoute.
- Acceptance: 68 source tests pass (13 new `locate-agent` tests, including one **over a real HTTP server with no injected test seams**). Measured against the running Manager: the codex session from the reported screenshot returns `opened` with `owner=codex_desktop` and the correct title; a forged id, an unsupported adapter, a missing id, a malformed body and a wrong method each return their own precise reason.

## 0.2.2 — 2026-09-16

- **Parse `plan` and `system` sources too.** Only `类型：Agent｜…` was recognized before; every other kind fell back to flat raw text, which left system events such as `agent_request_reminder` spread across the conversation. Each kind is now parsed from its own identity fields — a plan from its name and id, a system event from its name, type and id plus any optional actor and route values.
- **Plan and system rows fold by default.** Their header states what they describe (`计划 · name (id)` / `系统 · event name · event type`) and the body sits behind an inline toggle. Neither names a locatable session, so neither offers "Locate Agent"; Agent rows keep their existing always-visible body and navigation.
- A folded body is not rendered and `projectUserText` does not run; expanding or "View original message" still returns the complete original.
- Strictness is unchanged and now more explicit: fields mixed from another source kind, a half-written source identity, `消息端` and any unknown spelling still fall back to raw text.
- Acceptance: 53 source tests pass (18 envelope, 11 client). Deployed-instance acceptance is pending.

## 0.4.0 — 2026-09-19

- Clarify Rabi shared business ownership and DSH local adaptation, with common contracts reusable by Codex and other Agents.
- Record the scope of sender headers, original-message viewing and session navigation. UI integration first evaluates public plugin replacement and ordinary-message compatibility without changing historical records.

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

## 0.7.1 — 2026-09-20

- Add a question-card automatic voice switch using live Rabi microphone settings and the official draft/submit path.
- Follow silence segmentation, adaptive thresholds, ASR model and auto-submit policy; cancellation and navigation discard pending submission.
