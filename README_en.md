English | [简体中文](README.md)

# dsh-rabiroute-agent

## Reply mini player (0.5.0)

The footer speaker reads only the clicked reply body, excluding reasoning, tools and other messages. Empty replies hide the action; replies above 10000 characters are rejected. Generation disables duplicate clicks and displays an indeterminate progress indicator. The current Rabi TTS endpoint does not expose generation percentages.

Completed audio plays in the current browser. If autoplay is blocked, press play again. The 24px-high player provides play/pause, elapsed/total time and a seek slider. Seeking and replay reuse the audio without another synthesis request. Audio remains in page memory and is stopped and released when the message unmounts; it is neither persisted by DSH nor submitted to the Rabi host queue.

The public assistant-actions slot calls same-origin `POST /rabiroute/speech`. The adapter verifies Manager identity and service state and uses Rabi's default provider/model and voice with `play: false` and WAV output. Successful responses contain at most 32 MiB of `audio/wav`; failures contain JSON. Client and server must be updated together: restart DSH after installation and refresh the page. The plugin does not start services, keep separate TTS settings or retry automatically.

`speechTimeoutMs` separately controls generation waiting (default 300000 ms, bounded to 1000–900000); normal tools retain `requestTimeoutMs`. Disconnecting cancels waiting; computation already started by Rabi may continue without host playback. Errors appear beside the icon with a readable tooltip and accessible label.

Rabi owns synthesis and defaults; this plugin owns reply extraction, same-origin audio transport and the DSH mini player. Tests cover duplicate clicks, body isolation, seeking, pause/resume and cleanup. Installation, runtime loading and visual acceptance are reported separately.

## Official question card (0.6.2)

`ask_user_question` still answers through the official `conversation.composer` card. Options, skip, cancel and drafts are unchanged. This plugin wraps that card at a higher priority only to label free text as "Your own branch" and add a microphone on that field.

Voice input posts to same-origin `POST /rabiroute/speech/asr`. After Manager identity checks, Host transcribes the browser WAV with Rabi's **current default ASR** (the preloaded `faster-whisper/small`, ~0.5 s hot, faster than Qwen3-ASR 0.6B) and writes the text back into the official controlled field. DSH does not store ASR settings, pick a model, start speech services or fake option clicks. Failures are shown as stated; empty transcripts are not submitted. Restart DSH and refresh the page.

## Purpose and development boundaries

This plugin adapts DSH tool calls to Rabi; it is not a plan, memory, persona or messaging system inside DSH. Tool availability neither enables automatic Rabi scheduling nor proves that the separate lifecycle Hook is loaded.

Follow Rabi's [shared Agent integration requirements](https://github.com/vb2250158/RabiRoute/blob/main/docs/agent-adapter-standard-requirements_en.md): business behavior and policies that Rabi can implement centrally belong in Rabi, for reuse by DSH, Codex and other Agents. When a Rabi API is missing, extend the shared API first rather than duplicating business rules, state stores or schedulers in DSH.

This plugin owns only tool registration, request/result translation, connection checks and necessary communication constraints. Consider host enhancements only for DSH internal events, context injection, permission enforcement or UI that require host access, using supported extension points. Rabi business decisions cannot expand DSH local permissions. The separate `rabi-dsh-context` Hook owns lifecycle adaptation; do not duplicate it here.

Each new requirement must identify why Rabi cannot perform it directly, DSH's minimum local responsibility, authoritative business state, the shared cross-Agent contract, behavior without optional enhancements and acceptance evidence. Shared capabilities must not require Codex to reproduce DSH UI or make this plugin's installation a prerequisite for Rabi base session discovery and delivery. Describe tool integration, Hook integration and real business acceptance separately; API names are not DSH-owned business features.

## Chat message presentation (Unreleased, installed acceptance pending)

The enhancement recognizes a leading `[消息源]` envelope when chat loads or historical messages render, shows a source row above the body, and offers a "View original message" menu item. Recognition is display-only: session logs, model input, source identity and reply parameters remain unchanged, and the original stays accessible. Source text is a message claim, not authenticated sender evidence; reply JSON must never execute automatically.

Three source kinds are presented by their own identity fields. An **Agent** row shows the sending session above the body and offers "Locate Agent". **Plan** and **System** rows carry no session identity of their own, so their header states what they describe — the plan name and id, or the event name and type — and the body is folded by default, expandable from the header or an inline toggle. An unknown or misspelled source kind is not parsed and still renders as flat text.

The parser source is `src/message-envelope.js`, bundled by the browser build; the Host tool entry does not load it. It accepts current/legacy field names and LF/CRLF, preserves the original string and body whitespace, and separates only a valid terminal reply JSON block. Duplicate fields, unknown header fields, fields mixed from another source kind, a half-written source identity, ambiguous reply JSON or conflicting delivery IDs return `null`; callers must display the original. `消息端` has no presentation yet and, like unknown context blocks, receives no business interpretation.

Unsupported or ambiguous formats remain unchanged. Locate sessions by full ID, never by guessed names or by creating replacements. A **DSH** source is matched by full ID in the local catalog and selected in place; **any other adapter** (currently `codex`) is handed to RabiRoute's Agent-thread bridge (`action=open`) to raise that client's window — the local client does not hold the session, so deciding it here would only guess. Unknown targets and Rabi's own rejection reasons are reported as stated. Plan and system rows offer no locate entry point: they name no locatable session, and a control that cannot act reads as a broken link.

Folding is display-only: a folded body is not rendered and the `projectUserText` projection does not run, while expanding or "View original message" still returns the complete content.

### Locating an external adapter (0.3.0)

The browser calls the same-origin route `POST /rabiroute/locate-agent` with only `{ agentAdapter, threadId }`. Rabi declares no CORS policy for the DSH origin, so the browser cannot reach the Manager directly and the Host answers for it: it verifies `/meta` identity, calls `POST /api/agent/threads` (`action=open`), and turns Rabi's receipt into the result. Only those two fields travel — no message body and no credentials are proxied.

A `dsh` source does not take this path; it is selected in place from the local session catalog. When `agentAdapter` is outside the adapters Rabi supports, the plugin refuses before sending anything rather than letting Rabi reject it with a vaguer reason. Rabi's own rejection reason travels back verbatim.

The public `conversation.chat.node` slot can replace an entire node kind but cannot conditionally fall back to the official renderer. First evaluate a plugin-only replacement through this public API, accepting responsibility for ordinary messages, attachments, copying, timestamps and history loading. A missing local decoration slot alone does not require official-source changes. Do not capture private registries, import internal components or modify the DOM. Propose a minimal official extension point and request authorization only if public replacement cannot reliably meet the requirements. This section defines unreleased work, not evidence that chat presentation, navigation or menus are available.

## Rabi plan panel (0.2.0)

When a session is bound to a Rabi **persona**, the right Sidebar gains a "Rabi plan" page: entering that session opens it once, and **Rabi's icon button** beside the session title reopens it later. The panel does not re-draw a plan — it frames **Rabi's own single-plan view** (`#/routes/<route>/plan/<plan id>`); steps, feedback, approvals and attachments are presented and driven entirely by Rabi, and DSH keeps no second copy.

### Entry and closing (0.2.1)

| Behaviour | Rule |
| --- | --- |
| Entry | **Rabi's icon** beside the session title (shipped in this plugin, inlined at 64px, no runtime request). It appears once the session has a Rabi **persona binding**; with no `roleId` (unbound, or Manager unreachable) it stays hidden. |
| Why "a plan exists" is no longer the condition | 0.2.0 gated the entry on availability, which hid it in the normal interval between "the session is bound" and "Rabi has recorded a plan" — exactly when an entry is wanted. The entry now follows the binding; the panel explains an empty state. |
| Auto-open | Only when a plan really is bound, once per session. A bound session with no plan yet does not auto-open, so no empty column appears. |
| Closing | Closing and collapsing belong to DSH's own right column (each page has a close, the column collapses). A manual close is not undone by switching sessions: auto-open happens once per session. |
| Reopening | The icon button calls `sidebarRight.openTab`, the same path auto-open uses. |

**Icon source**: `RabiRoute/assets/rabiroute-icon.png`, downscaled to 64px and inlined into the client bundle (`src/plan-icon.js`, ~4 KB). It is not fetched at runtime: the DSH client has no dependable URL for Rabi's static assets, and a fetch would blink an empty button.

**The panel shows exactly one plan — the one bound to that session.** The criterion is not DSH's: `plan.taskBinding.sessionId` (and the secretary binding) is the only session↔plan link in Rabi, and Rabi's own Stop path matches on it. When a session is bound to more than one plan, Rabi treats that as a state to settle (`multiple_plan_task_bindings`), so the panel **reports rather than chooses**, naming the plans instead of picking one.

There is exactly one data path. The browser calls the same-origin read-only route `GET /rabiroute/plan-panel?sessionId=<DSH session id>`; the Host discovers Manager, verifies `/meta` identity, then reads — `GET /api/codex-hook/sessions/<session>` for the bound role, paged reads of that role's **current plan summaries** matched against Rabi's binding criterion (`view=current`, 200 summaries per page, at most 8 pages), and `GET /api/gateways?summary=1` to map the role to a route — before returning the page address. No plan body is read, the full catalog is never pulled (hundreds of plans, hundreds of kilobytes per page), no state is written, and no binding is cached.

The panel therefore has exactly three outcomes: available (with a single-plan address), empty with a reason, or loading. The reasons are `unbound`, `no-plan`, `multiple-plans`, `unrouted` (the role owns no route), `no-session`, and `unreachable` (Manager is down). **An unreachable Manager never produces a cached or inferred plan**: when Rabi is absent, the panel reports the absence.

The plan tab registers under this plugin's own id (`dsh-rabiroute-agent/plan`) as an independent page type and takes over no existing type. It contributes no guide entry either, so the Sidebar behaves exactly as before in sessions that hold no bound plan.

### Cross-repository dependency (Rabi front end must carry the single-plan address)

The single-plan view lives in Rabi's front end: the `ribiwebgui` plan page gains the focus address `/routes/:id/plan/:planId`, reusing the same plan rendering while narrowing what is loaded and shown (no directory, no paging, no memory panels, plan opened by default). That is a **front-end-only** change, so the Web hot-patch channel publishes it — no Manager backend change and no release reinstall is required.

Without that address the panel reports unreachable or not-found rather than degrading into the full catalog page.

Known limits in this version:

- The panel is an iframe, so it still carries Rabi WebGUI's page shell (top bar and navigation); only its content narrows to a single plan.
- The browser must be able to reach Manager. On the same machine that holds: loopback requests need no token, and if Rabi has LAN WebGUI access enabled the page redirects itself to the LAN address with an access token, leaving the panel unaffected (verified). Reached from another machine, the frame points at that machine's own `127.0.0.1` and the panel is unusable; cross-machine access is not handled yet.
- The Electron client loads its UI over `file://`, where the relative same-origin route is unavailable; the panel then reports the unreachable reason.
- Auto-opening happens once per session; after a manual close it does not keep reopening.

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

## Automatic voice input (0.6.3)

The question card switch follows live Rabi microphone segmentation, ASR and auto-submit settings. Cancellation, draft edits or navigation stop capture. Recognition success turns the switch off. See [Automatic voice input](AUTO-VOICE.md).
