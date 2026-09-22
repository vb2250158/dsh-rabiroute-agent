English | [简体中文](PLAN-RESOURCES.md)

# Plan resource archiving

Images and files submitted by a user are archived from durable DSH attachment references. A single bound plan receives them automatically. With multiple plans, the Agent must use `rabiroute_plan_resources` actions `list` and `select` to assign each group of `itemIds` to a `roleId` and `planId`. The tool verifies that the plan belongs to the executing DSH session. User messages remain unchanged.

Before modifying files, the Agent selects a `stepId`. Successful official `write` and `edit` results automatically record paths, change kinds and content digests. Shell, external editor and other tool changes are submitted through `record_changes`. Rabi stores these under `steps[].resourceRecords`, distinguishing `tool-observed` from `agent-reported`; unrelated workspace changes are not attributed to this task. Rabi Web displays them in the step's File changes section.

Background writes use strong ETags, stable idempotency keys and authoritative readback. Failures retain pending records. Uncertain writes are only read back, never automatically replayed. Sending a user message or assembling model context does not wait for archival requests. Other tools are denied until a multi-plan session selects a plan. A new user message clears that selection.

`planResourcesEnabled` defaults to true. `planResourcesDirectory` defaults to `storages/rabiroute-plan-resources` under the DSH data directory. Defaults for `planResourceRetryMs`, `planResourceTimeoutMs` and `planResourceMaxBytes` are 30000, 12000 and 10485760. Oversized files remain in DSH with an explicit pending error. An empty `pending` list confirms archival; do not manually delete the queue.

The Rabi server must support step resource records and batched attachment appends. If an older server rejects or drops the new fields, confirmation remains pending. Retained attachments are preserved; each upload batch remains limited to 8 new files, 10 MiB per file and 25 MiB of new content.
