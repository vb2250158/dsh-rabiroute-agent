import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = (await readFile(new URL('../src/client-auto-speech.js', import.meta.url), 'utf8'))
  .replace(/^import [^\r\n]*\r?\n/gmu, '').replace(/^export /gmu, '')
const context = { Error, document: { hidden: false }, React: {} }
vm.runInNewContext(source + '\nglobalThis.api = { createRabiReplyGate, createRabiAutoReadStore, registerRabiAutoSpeech }', context)
const reply = (seq, extra = {}) => ({ seq, kind: 'assistant', messageId: `reply-${seq}`, blocks: [{ kind: 'text', text: 'Reply' }], ...extra })
const snapshot = (...eventNodes) => ({ eventNodes })
const ids = value => Array.from(value)

test('initial history, disabled replies, reconnect and repeated projection never trigger reading', () => {
  const gate = context.api.createRabiReplyGate()
  assert.deepEqual(ids(gate.take(snapshot(reply(1)), false, true)), [])
  assert.deepEqual(ids(gate.take(snapshot(reply(1)), true, true)), [])
  assert.deepEqual(ids(gate.take(snapshot(reply(1), reply(2)), true, false)), [])
  assert.deepEqual(ids(gate.take(snapshot(reply(1), reply(2)), true, true)), [])
  assert.deepEqual(ids(gate.take(snapshot(reply(3), reply(4)), true, true)), ['reply-3', 'reply-4'])
  assert.deepEqual(ids(gate.take(snapshot(reply(3), reply(4)), true, true)), [])
  gate.take(snapshot(), false, true)
  assert.deepEqual(ids(gate.take(snapshot(reply(3), reply(4), reply(5)), true, true)), [])
  assert.deepEqual(ids(gate.take(snapshot(reply(6)), true, true)), ['reply-6'])
})

test('only finalized reply bodies qualify; reasoning, tools, empty text and interruptions are excluded', () => {
  const gate = context.api.createRabiReplyGate()
  gate.take(snapshot(), true, true)
  const nodes = [reply(1, { blocks: [{ kind: 'reasoning', text: 'Private thought' }] }),
    reply(2, { blocks: [{ kind: 'text', text: 'Calling a tool' }, { kind: 'tool-call' }] }),
    reply(3, { blocks: [{ kind: 'text', text: '  ' }] }), reply(4, { interrupted: true }),
    reply(5, { messageId: undefined }), reply(6)]
  assert.deepEqual(ids(gate.take(snapshot(...nodes), true, true)), ['reply-6'])
})

test('hidden-page reset seeds the resumed history rather than reading missed replies', () => {
  const gate = context.api.createRabiReplyGate()
  gate.take(snapshot(reply(1)), true, true)
  gate.reset()
  assert.deepEqual(ids(gate.take(snapshot(reply(2)), true, true)), [])
  assert.deepEqual(ids(gate.take(snapshot(reply(3)), true, true)), ['reply-3'])
})

test('optional preference observation disables on carrier failure and joins disposal', async () => {
  const changes = [], accepted = []
  let carrierFailed, receive, finish
  const next = () => new Promise(resolve => { receive = resolve })
  const stream = {
    async *[Symbol.asyncIterator]() { while (true) { const item = await next(); if (!item) return; yield item } },
    dispose: async () => { receive(null); finish = true },
  }
  const store = context.api.createRabiAutoReadStore({ remote: { $stream: options => { carrierFailed = options.carrierFailed; return stream } } })
  const unsubscribe = store.subscribe(() => changes.push(store.getSnapshot()))
  const send = async autoRead => {
    receive({ value: { inputPreferences: { autoRead } }, accept: () => accepted.push(autoRead) })
    await new Promise(resolve => setImmediate(resolve))
  }
  await send(true)
  assert.equal(store.getSnapshot(), true)
  carrierFailed(new Error('offline'))
  assert.equal(store.getSnapshot(), false)
  await send(true)
  await store.dispose()
  assert.deepEqual(changes, [true, false, true, false])
  assert.deepEqual(accepted, [true, true])
  assert.equal(finish, true)
  unsubscribe()
})
