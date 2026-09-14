# dsh-rabiroute-agent

English | [简体中文](README.md)

Connect DSH sessions to RabiRoute's managed task, messaging, plan and memory APIs. Business contracts align with Codex, while DSH retains its own sessions, tools and permissions. No fallback Runtime or automatic handoff to Codex is introduced.

> Connection changes shipped in **0.1.5**, with isolated installation through the official installer and read-only connectivity verified. Source tests, production-profile installation, running tools, Hooks and real delivery require separate acceptance. Isolated verification does not prove production deployment.

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
