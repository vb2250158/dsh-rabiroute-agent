import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installNativeHooks } from '../lib/native-hooks.js'

test('built hooks append receipts through a source-launched Session and retain the Hook transcript', {
  skip: !process.env.DSH_TEST_SOURCE_ROOT,
}, async () => {
  const sourceRequire = createRequire(join(process.env.DSH_TEST_SOURCE_ROOT, 'package.json'))
  const { tsImport } = sourceRequire('tsx/esm/api')
  const { Session, SessionId } = await tsImport(pathToFileURL(join(process.env.DSH_TEST_SOURCE_ROOT, 'packages/core/session/src/index.ts')).href, import.meta.url)
  const session = Session.create(SessionId('source-hook-fixture'))
  const handlers = new Map(), requests = [], disposers = []
  const ctx = {
    effect: callback => disposers.push(callback()),
    on: (point, handler) => handlers.set(point, handler),
    workingDirectory: { get: () => 'fixture-workspace' },
    logger: { warn() { assert.fail('fixture Manager request failed') } },
  }
  installNativeHooks(ctx, {}, { request: async (_config, _path, options) => {
    const point = JSON.parse(options.body).eventName
    requests.push(point)
    return { ok: true, statusCode: 200, body: JSON.stringify({ code: 0, data: point === 'SessionStart' ? { additionalContext: 'fixture context' } : {} }) }
  } })
  try {
    const agent = { session }
    const messages = [{ content: [{ type: 'text', text: 'hello' }] }]
    const signal = new AbortController().signal
    const enter = await handlers.get('agent/pre-step')({ agent, messages, turn: 1, signal }, async () => ({ kind: 'enter', messages }))
    await handlers.get('agent/turn-stopping')({ agent, turn: 1, signal })
    const records = session.snapshotEvents().map(event => ({ type: event.type, ignorable: event.ignorable,
      point: event.data.point, turn: event.data.turn, ...(event.data.outcome ? { outcome: event.data.outcome, statusCode: event.data.statusCode } : {}) }))
    const expected = JSON.parse(await readFile(new URL('./expected/native-hooks-source-session.json', import.meta.url), 'utf8'))
    assert.deepEqual({ requests, records, contextSource: enter.messages.at(-1).source }, expected)
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
  }
})
