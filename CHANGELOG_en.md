# Changelog

English | [简体中文](CHANGELOG.md)

## Unreleased

- Clarify Rabi shared business ownership and DSH local adaptation, with common contracts reusable by Codex and other Agents.
- Add standalone envelope parser source and synthetic format tests without runtime registration; preserve original text, body whitespace and fallback without executing reply JSON.
- Record the unreleased scope of sender headers, original-message viewing and session navigation. UI integration first evaluates public plugin replacement and ordinary-message compatibility without changing historical records; it is not connected or deployed.

## 0.1.5 — 2026-09-14

- Align DSH tools with the current Codex/Manager contract using per-operation Host discovery, health and generation/instance checks; remove fixed-port defaults and prompt addresses.
- Add restricted version/idempotency headers, full response metadata, post-write identity checks and explicit uncertainty. Business requests are not automatically replayed.
- Add read-only health and sending-receipt queries, stricter paths/redirects, source-conflict validation and cancellation handling.
- Synchronize source and packaged entry in the build; add connection/failure regressions and remove unloaded legacy no-op invariant modules.
- Published a pinned commit and verified isolated installation through the official installer. The installed package passed dynamic Host discovery and read-only `/meta` checks. Production-profile installation remains subject to local transaction checks; the separate DSH Hook, real delivery and storage writes are outside this read-only acceptance.
