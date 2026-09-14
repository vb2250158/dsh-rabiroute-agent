# Changelog

English | [简体中文](CHANGELOG.md)

## Unreleased

- Align DSH tools with the current Codex/Manager contract using per-operation Host discovery, health and generation/instance checks; remove fixed-port defaults and prompt addresses.
- Add restricted version/idempotency headers, full response metadata, post-write identity checks and explicit uncertainty. Business requests are not automatically replayed.
- Add read-only health and sending-receipt queries, stricter paths/redirects, source-conflict validation and cancellation handling.
- Synchronize source and packaged entry in the build; add connection/failure regressions and remove unloaded legacy no-op invariant modules.
- Not yet published or installed. The separate DSH Hook, real delivery and storage writes are outside this read-only runtime acceptance.
