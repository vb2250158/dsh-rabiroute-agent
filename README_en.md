# dsh-rabiroute-agent

English | [简体中文](README.md)

Connect DSH sessions to RabiRoute's managed task, messaging, plan and memory APIs. Business contracts align with Codex, while DSH retains its own sessions, tools and permissions. No fallback Runtime or automatic handoff to Codex is introduced.

> Connection changes shipped in **0.1.5**, with isolated installation through the official installer and read-only connectivity verified. Source tests, production-profile installation, running tools, Hooks and real delivery require separate acceptance. Isolated verification does not prove production deployment.

## Purpose and development boundaries

This plugin adapts DSH tool calls to Rabi; it is not a plan, memory, persona or messaging system inside DSH. Tool availability neither enables automatic Rabi scheduling nor proves that the separate lifecycle Hook is loaded.

Follow Rabi's [shared Agent integration requirements](https://github.com/vb2250158/RabiRoute/blob/main/docs/agent-adapter-standard-requirements_en.md): business behavior and policies that Rabi can implement centrally belong in Rabi, for reuse by DSH, Codex and other Agents. When a Rabi API is missing, extend the shared API first rather than duplicating business rules, state stores or schedulers in DSH.

This plugin owns only tool registration, request/result translation, connection checks and necessary communication constraints. Consider host enhancements only for DSH internal events, context injection, permission enforcement or UI that require host access, using supported extension points. Rabi business decisions cannot expand DSH local permissions. The separate `rabi-dsh-context` Hook owns lifecycle adaptation; do not duplicate it here.

Each new requirement must identify why Rabi cannot perform it directly, DSH's minimum local responsibility, authoritative business state, the shared cross-Agent contract, behavior without optional enhancements and acceptance evidence. Shared capabilities must not require Codex to reproduce DSH UI or make this plugin's installation a prerequisite for Rabi base session discovery and delivery. Describe tool integration, Hook integration and real business acceptance separately; API names are not DSH-owned business features.

## Chat message presentation (Unreleased, installed acceptance pending)

The intended enhancement recognizes a leading `[消息源]` Agent envelope when chat loads or historical messages render, displays a clickable sending session above the body, and offers “View original message” and “Locate Agent” menu items. Recognition is display-only: session logs, model input, source identity and reply parameters remain unchanged, and the original stays accessible. Source text is a message claim, not authenticated sender evidence; reply JSON must never execute automatically.

The standalone parser source is `src/message-envelope.js`; the current runtime entry does not load it. It recognizes Agent sources only, accepts current/legacy field names and LF/CRLF, preserves the original string and body whitespace, and separates only a valid terminal reply JSON block. Duplicate fields, unknown header fields, ambiguous reply JSON or conflicting delivery IDs return `null`; callers must display the original. Other source types and unknown context blocks receive no business interpretation.

Unsupported or ambiguous formats remain unchanged. Locate sessions by full ID, never by guessed names or by creating replacements. Rabi owns resolution and opening contracts for external Agents; a Codex ID is not a local DSH ID. Unknown targets and unsupported hosts must produce explicit feedback.

The public `conversation.chat.node` slot can replace an entire node kind but cannot conditionally fall back to the official renderer. First evaluate a plugin-only replacement through this public API, accepting responsibility for ordinary messages, attachments, copying, timestamps and history loading. A missing local decoration slot alone does not require official-source changes. Do not capture private registries, import internal components or modify the DOM. Propose a minimal official extension point and request authorization only if public replacement cannot reliably meet the requirements. This section defines unreleased work, not evidence that chat presentation, navigation or menus are available.

## Installation

Use Settings → My Plugins or the official installer with an available pinned commit:

```powershell
pnpm dsh plugin --profile web add --save-exact github:vb2250158/dsh-rabiroute-agent#<commit>
```

Use the actual local DSH Home/profile. The package registers through `dsh.bundle`, without modifying official source. Preserve configuration and lockfiles. Resolve unfinished environment/plugin transactions through managed recovery; never delete journals, overwrite installed caches or substitute local links. Reload through the existing managed entry after active work ends, then verify the loaded version and tool schemas.

## Configuration

In the active profile's `cordis.patch.yml`:

```yaml
- id: rabiroute-agent
  config:
    managerBaseUrl: ""
    hostExecutable: ""
    enforceAgentCommunication: true
    requestTimeoutMs: 30000
```

Keep machine-specific values local, outside shared patches.

- Empty `managerBaseUrl`: discover the complete current address through Host `status --json` for each operation; verify `/meta` health, required capabilities and nonempty generation/instance identities against Host before business dispatch. No stale-address cache or port scan.
- Nonempty `managerBaseUrl`: explicitly select a development/external HTTP(S) origin without path, query, fragment or credentials. Health and identity checks remain mandatory; failure never changes target. Source mode can explicitly configure its current structured READY address.
- `hostExecutable`: optional local Host executable. On Windows, the empty setting derives the conventional installation location from `LOCALAPPDATA`; other platforms require an explicit Host or Manager. Only read-only status is executed, never service start/stop.
- `requestTimeoutMs`: whole-operation budget, default 30 seconds, range 1–120 seconds. Each HTTP request is capped at 12 seconds; Host status at 3 seconds. Cancellation propagates.
- `enforceAgentCommunication`: retain dedicated-tool enforcement for formal communication.

Registration does not access Host, so Manager absence does not prevent DSH startup. `active=true` means tools registered, not business health. Clear an explicitly configured old address to select Host mode; explicit targets are never silently ignored.

## Tool contracts

- `rabiroute_agent_threads`: discover, read, resolve, create, rename, continue and formally reply through Manager. Preserve full task identity and existing bindings; conflicting source IDs are rejected. Legacy `deliverySource` input is normalized at the boundary; Manager receives only `messageSource`. Reply policies and formal reply fields follow the current Manager contract.
- `rabiroute_agent_send`: explicit external sending, preserving `deliveryId`, sender identity and channel receipts. HTTP success is not real channel delivery.
- `rabiroute_manager_api`: allowlisted plan, memory, message-processing and reply-request APIs, plus exact `GET /meta`, `GET /api/agent/send/receipts/:id` and `GET /api/agent/send/traces`. Health/receipt endpoints are GET-only. Traversal, encoded separators and cross-origin redirects are rejected.

The general tool supports `GET/POST/PUT/PATCH/DELETE`. Optional `requestHeadersJson` accepts only `If-Match` and `Idempotency-Key`. Example:

```json
{
  "method": "PATCH",
  "path": "/api/roles/example-role/plans/example-plan",
  "bodyJson": "{\"currentStep\":\"Updated from verified evidence\"}",
  "requestHeadersJson": "{\"If-Match\":\"\\\"revision-from-get\\\"\",\"Idempotency-Key\":\"stable-operation-id\"}"
}
```

This example is not execution authorization. Read current API documentation, the status catalog, resource and strong ETag before writing.

- Creating plans/recent memories and requesting consolidation require stable keys. Updating plans/recent memories, feedback, consolidation results and versioned status catalogs additionally require strong ETag `If-Match`. Requirements are not imposed indiscriminately on every API; Manager retains business validation.
- Output retains HTTP status, body string, permitted response headers, ETag, identity and `uncertain/error`; rendering includes all fields. Success still requires checking echoed keys, strong ETags, resource identity and authoritative readback. The plugin does not perform semantic acceptance automatically.
- Writes are never automatically replayed. Timeouts, 503s, network failures and post-write identity changes preserve uncertainty and available responses. Keep the original key/body and read back first. After 412, read again, confirm intent, then use a fresh key and ETag.
- Only pre-dispatch discovery failures of GET operations allow one rediscovery. Business GETs are not replayed either: reading recent memory can update `viewedAt`. Use `/meta` for health probes.

## Hook and Codex boundaries

Follow the current Manager contract, rather than copying missing identity/header checks in older Codex clients. `rabi-dsh-context` is a separate lifecycle Hook. This plugin does not duplicate personas, memory or Hook decisions and does not prove SessionStart, permission checks, Stop or real delivery. Check Hook and tool configurations independently; neither path may hide the other's failures.

## Verification and troubleshooting

```powershell
npm test
npm run build
npm pack --dry-run
```

Build synchronizes `src/index.js` and `src/connection.js` to the actual `lib` entry. Tests cover artifact consistency, generation changes, identity rejection, headers, 412/503, non-replay, source conflicts, path isolation and cancellation. Inspect package contents for user configuration, credentials, business data and private identifiers before publishing.

Minimum live acceptance: execute `GET /meta` through the new package's exported tool definition and compare Host identity. After installation/reload, repeat with the session's registered tool. The first check does not replace the second, nor prove writes or Hooks.

For old-version `fetch failed`, compare effective tool configuration with current Host status. A retired port failure does not prove Manager is offline. Never turn today's dynamic port into a new hardcoded default.

## License

MIT
