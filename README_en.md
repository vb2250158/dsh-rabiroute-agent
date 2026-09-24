English | [简体中文](README.md)

v0.13.8

A Rabi button appears for workspaces matching a routed persona. Its dialog lists plans bound to existing DSH sessions in that workspace, using WebGUI search and status colors with status/tag/view/sort filters and pagination. Titles are display-only. Opening a bound session loads its associated plan through the session panel; multiple bindings offer a session choice. Discovery scans no plans. Loaded pages are cached for the plugin lifetime; closing cancels the active read but retains one lightweight event subscription. Reopening an unchanged page makes no query. Role-scoped events reconcile changed rows only; inactive pages reconcile on reopening. Server-owned order, counts, and facets remain authoritative. Reconnect reconciles cached state; failures retain rows with an error. Configure `workspacePlanCachePages` (32) and `workspacePlanEventDelayMs` (200) to bound retained pages and coalesce events. Requires Rabi `POST /api/roles/:roleId/plans/query` and the host `sidebar.workspaces.workspace.actions` slot.

Plan-bound sidebar titles omit up to two leading `[category]` tags. Durable titles, search indexes, and hover details remain intact. Titles share the badge cache and event subscription without additional requests. Requires the host `sidebar.workspaces.session.title` presentation slot.

## Plan context (0.9.5)

Official `systemPrompt.context` includes the session's bound plan summaries when user input reaches the model: title, status, current step, progress, update time, and executable `rabiroute_manager_api` detail arguments. Multiple plans keep their own identities. User text is unchanged; logged context snapshots supersede older values, and unbinding clears the current context.

Context assembly shares the sidebar's event-invalidated TTL cache and never waits for Manager or fetches plan bodies. Cold or failed reads are explicitly unavailable or stale. `planContextEnabled` defaults to true, `planContextMaxPlans` to 16, and `planContextTextLimit` to 300. Rabi remains authoritative; this plugin only adapts DSH context assembly and durable logging.

# dsh-rabiroute-agent

## Plan resource archiving (0.10.0)

User images and files are archived to a single bound plan automatically. With multiple plans, the Agent explicitly assigns them through a dedicated tool. Changed files are recorded on the selected step, distinguishing tool observations from Agent reports. Background archival survives restart without blocking message submission. See [plan resource archiving](PLAN-RESOURCES_en.md).

Badge refresh merges validated pages immediately and retains known bindings after later failures. Only a complete scan removes missing bindings. The background `planStatusTimeoutMs` budget defaults to 120 seconds; cache HTTP reads still return immediately.

## Session plan-status badges (0.9.3)

Grouped, flat and search session rows display the status of their bound Rabi plan. This plugin owns retrieval, caching and rendering. The host must expose the generic `sidebar.workspaces.session.badges` slot with the actual row's `sessionId`; older hosts without that slot retain other features without badges.

`GET /rabiroute/plan-statuses` returns cached data immediately and refreshes in the background on demand. All sessions share one paginated summary scan, without plan bodies or blocking session navigation and Agent execution. Defaults are `planStatusCacheMs: 60000`, `planStatusTimeoutMs: 15000` and `planStatusMaxPages: 24`. One same-origin `GET /rabiroute/plan-events` stream coalesces Manager plan and status-catalog notifications. Healthy snapshots are not polled. Reconnect calibrates the cache; hidden pages, no subscribers and disposal close the stream. Badges may take a few seconds to appear on first load.

Conflicting bindings display “Multiple plans”. Failed refreshes retain the last complete snapshot with stale information only in the tooltip, preserving text and color during refresh. Labels and palettes come from summary presentation data; the Rabi accent is mixed with the active theme surface. Queries do not filter by view, covering paused and completed statuses. A page-budget failure never publishes a partial result. Persona discovery follows the current Manager route catalog.

## Message processing mode (0.7.0)

The `message-processing` preset adds **消息处理模式** to the session mode picker. It handles incoming messages, Rabi channel/persona delivery, reading and creating Agent sessions, task delegation and progress, and plan creation, queries, updates, deletion, bindings, statuses and feedback.

Only `rabiroute_agent_threads`, `rabiroute_agent_send` and `rabiroute_manager_api` remain available. The preset mounts no shell, general filesystem/skill, web, subagent or workflow tools. An inherited-tool allowlist, native presentation and a monotonic `tools.guard` deny other execution, including tools registered later and PTC. Other presets are unaffected. General file searching, enumeration, reads, writes and attachment uploads/downloads are prohibited, including file payloads sent through Rabi; session workspace metadata remains valid routing information. Rabi-managed persona documents, skills, plans and memory remain readable through their business APIs.

The coordinator delegates investigation, research, solution design, implementation, testing and acceptance, even when the work could be answered without tools. It reads relevant memory, plans and skills first, assigns work, tracks replies, checks reported evidence, and maintains plans and confirmed memories. Rabi/persona skills use `/api/roles/<roleId>/skills` and its item endpoint; their operational work is delegated and never expands tool permissions. Tool restrictions are enforced by the runtime; the division of reasoning work is a prompt instruction.

The mode includes API and request-field guidance, current session identity from each prompt assembly, reply/receipt handling, idempotency and ETag rules. It can discover the current persona binding via read-only `/api/codex-hook/sessions/<sessionId>` without local document access. Missing identity, binding or cross-persona capability must never be fabricated. Recent memories support creation and updates; consolidated memories remain read-only under the Manager contract, with corrections recorded as recent memory and consolidation delegated.

Rabi owns messages, sessions and plans. DSH owns the picker and local tool enforcement, which Rabi cannot implement inside the host. No business queue or plan store is added. Manager failure never enables shell/file fallbacks. Rabi persistence, DSH session logging and Host discovery are infrastructure, not model file permissions; existing input and independent lifecycle hooks remain owned by their providers.

After installing a fixed Git revision, copy the installed package's two `presets/message-processing/` YAML files into the actual DSH Home's `.agent-presets/message-processing/`. Inspect an existing preset before changing it; do not overwrite user configuration. The preset references the package export `dsh-rabiroute-agent/message-mode` without copying runtime code. Alternatively append the installed package's `presets/` directory to `agent-presets.config.roots`, preserving existing roots and the default. Official discovery supplies the picker; select the mode for a new session. Sessions with recorded messages cannot switch presets. Missing Rabi tools or missing `tools.guard`, `tools.restrict` or `tools.presentAs` support fail mounting explicitly.

Run `npm test`, then set `DSH_SOURCE_ROOT` to a built official checkout and run `node --test tests/message-mode.integration.mjs` for real tool-runtime scope, denial, Rabi forwarding and disposal checks. Manager receipts in that test are simulated; installation, visible UI and real business delivery require separate acceptance.

## Reply mini player (0.5.0)

The footer speaker reads only the clicked reply body, excluding reasoning, tools and other messages. Empty replies hide the action; replies above 10000 characters are rejected. Generation disables duplicate clicks and displays an indeterminate progress indicator. The current Rabi TTS endpoint does not expose generation percentages.

Completed audio plays in the current browser. If autoplay is blocked, press play again. The 24px-high player provides play/pause, elapsed/total time and a seek slider. Seeking and replay reuse the audio without another synthesis request. Audio remains in page memory and is stopped and released when the message unmounts; it is neither persisted by DSH nor submitted to the Rabi host queue.

The public assistant-actions slot calls same-origin `POST /rabiroute/speech`. The adapter verifies Manager identity and service state and uses Rabi's default provider/model and voice with `play: false` and WAV output. Successful responses contain at most 32 MiB of `audio/wav`; failures contain JSON. Client and server must be updated together: restart DSH after installation and refresh the page. The plugin does not start services, keep separate TTS settings or retry automatically.

`speechTimeoutMs` separately controls generation waiting (default 300000 ms, bounded to 1000–900000); normal tools retain `requestTimeoutMs`. Disconnecting cancels waiting; computation already started by Rabi may continue without host playback. Errors appear beside the icon with a readable tooltip and accessible label.

Rabi owns synthesis and defaults; this plugin owns reply extraction, same-origin audio transport and the DSH mini player. Tests cover duplicate clicks, body isolation, seeking, pause/resume and cleanup. Installation, runtime loading and visual acceptance are reported separately.

## Official question card (0.6.2)

`ask_user_question` still answers through the official `conversation.composer` card. Options, skip, cancel and drafts are unchanged. This plugin wraps that card at a higher priority only to label free text as "Your own branch" and add a microphone on that field.

Voice input posts to same-origin `POST /rabiroute/speech/asr`. After Manager identity checks, Host transcribes the browser WAV with Rabi's **current default ASR** (the preloaded `faster-whisper/small`, ~0.5 s hot, faster than Qwen3-ASR 0.6B) and writes the text back into the official controlled field. DSH does not store ASR settings, pick a model, start speech services or fake option clicks. Failures are shown as stated; empty transcripts are not submitted. Restart DSH and refresh the page.

The workspace Rabi plans dialog provides Check advancement and Advance settings. Persona-owned workspace rules configure each plan status with its own prompt, trigger condition, action, cooldown, and per-step run limit. Automation is off by default. When enabled, it observes plan and feedback changes and completed sessions, with optional startup and due checks. The check view previews eligible plans and the exact delivery prompt before sending selected items to their original bound DSH sessions in queue mode. Advance all idle sessions checks every page in the current persona workspace, sends at most once per eligible original idle session per pass, and shows progress counts. Approval gates, paused or terminal plans, mismatched bindings, and busy sessions are skipped. Rabi persists dispatch receipts to prevent replay of the same change; uncertain outcomes stop automatic retries pending verification.

The settings dialog explains the trigger and dispatch path, initially expands a configurable status, and shows its persona-owned description beside the editable prompt. Rabi combines that description with the rule prompt, plan and step identity, and authorization constraints; the agent rereads the current plan before acting.

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
| Closing and switching | The plugin records each session's panel choice when the user closes, collapses, or switches right-side tabs. Returning to a session does not reopen a plan the user closed. DSH still owns the current layout; the plugin retains only the choice in browser session storage, including across page reloads. |
| Reopening | The icon button calls `sidebarRight.openTab`, the same path auto-open uses. |

**Icon source**: `RabiRoute/assets/rabiroute-icon.png`, downscaled to 64px and inlined into the client bundle (`src/plan-icon.js`, ~4 KB). It is not fetched at runtime: the DSH client has no dependable URL for Rabi's static assets, and a fetch would blink an empty button.

A single bound plan opens directly. Multiple bound plans display a clickable directory retaining each role and route identity. Labels and colors come from Rabi summaries. Only the selected detail page is mounted; switching entries does not repeat binding queries. Reload reads Rabi again.

There is exactly one data path. The browser calls the same-origin read-only route `GET /rabiroute/plan-panel?sessionId=<DSH session id>`; the Host discovers Manager, verifies `/meta` identity, then reads — `GET /api/codex-hook/sessions/<session>` for the bound role, paged reads of that role's **current plan summaries** matched against Rabi's binding criterion (`view=current`, 200 summaries per page, at most 8 pages), and `GET /api/gateways?summary=1` to map the role to a route — before returning the page address. No plan body is read, the full catalog is never pulled (hundreds of plans, hundreds of kilobytes per page), and no state is written. The browser keeps verified panel resolutions by session for this plugin lifetime, without evicting them as other sessions open. After a browser reload it restores plan identities and a credential-free origin from session storage before reconciling in the background. Relevant plan events reconcile only affected sessions. Failures keep the last verified result visible with a stale notice; manual reload forces a read. Credential-bearing URLs are never persisted.

The panel returns a single-plan address or a directory. Missing bindings, plans, routes and unavailable Manager remain explicit. Current summary pagination must complete within its budget; an incomplete scan fails instead of returning a truncated directory.

The plan tab registers under this plugin's own id (`dsh-rabiroute-agent/plan`) as an independent page type and takes over no existing type. It contributes no guide entry either, so the Sidebar behaves exactly as before in sessions that hold no bound plan.

### Cross-repository dependency (Rabi front end must carry the single-plan address)

The single-plan view lives in Rabi's front end: the `ribiwebgui` plan page uses the focus address `/routes/:id/plan/:planId`, reusing the same plan rendering while narrowing what is loaded and shown (no directory, no paging, no memory panels, plan opened by default). On reopening, Rabi Web displays its browser-session snapshot immediately; Manager returns `304` or a changed detail body by view revision. This cache behavior requires both the Rabi Web and Manager updates.

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

## Degraded connectivity contract (0.8.0)

Ordinary requests and plan-panel discovery require `/meta` to report `live=true`, `requiredReady=true`, and either `healthy` or `degraded`, with nonempty generation/instance identities matching Host. An unrelated Route failure no longer blocks every tool; Manager endpoints still enforce plan recovery, target Route and Agent availability.

Exact `GET /meta` requires identity validation only and reuses the discovery response, allowing diagnosis while required capabilities are unavailable. Query variants and other paths do not inherit this exemption. Post-write verification checks identity only: health changes do not invalidate an existing success receipt. Identity changes, unverifiable identity, timeouts and 5xx responses remain uncertain and are never replayed automatically. Address, cancellation, redirect, allowlist, idempotency-key and ETag protections remain unchanged.

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

## Automatic voice input (0.7.2)

The question card switch follows live Rabi microphone segmentation, ASR and auto-submit settings. Cancellation, draft edits or navigation stop capture. Recognition success turns the switch off. See [Automatic voice input](AUTO-VOICE.md).


### Plan binding without Hook persona state

A session with no Hook persona binding is resolved against current plan summaries for the distinct roles returned by Rabi routes. Exact task or secretary session IDs identify the plan. Multiple matches remain a conflict; failed or incomplete reads remain unresolved. This lookup never creates a persona binding.

## Workspace persona skills (0.8.0)

Rabi enhancement registers a cwd-sensitive provider through `skills.registerProvider`. Enabled Agent workspaces come from `/api/gateways` state fields `monitorThreadCwd` or `monitorProjectPath`. Rabi owns bindings and skills. Remote instance configuration absent from this endpoint is not matched.

Exact absolute-path matching normalizes Windows case, separators and extended path prefixes. Child directories do not inherit bindings. Active skills from matching personas are merged and repeated routes deduplicated. Names contain persona, skill ID and an identity hash; descriptions contain title, summary and keywords. The official catalog, loader and explicit invocation retain their normal session logging.

`workspaceSkillsEnabled` defaults to true. Positive integer `workspaceSkillCacheMs` defaults to 30000. Expiry invalidates the DSH registry; bodies are read on demand. Failed discovery is never cached as an empty catalog. Other providers remain available. Loading rechecks workspace and active status. Disposal aborts requests and clears timers. Resources remain opaque Rabi resources, not local DSH paths.

Run `node --test tests/workspace-skills.test.mjs`. Set `DSH_SOURCE_ROOT` to a built DSH checkout and run `node --test tests/workspace-skills-registry.test.mjs` for registry, catalog, loader, explicit invocation, expiry and disposal coverage.
