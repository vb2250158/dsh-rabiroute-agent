import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { synthesizeRabiSpeech, createSpeechHandler } from '../src/speech.js'
import { resolveManagerBase } from '../src/connection.js'

const input = { text: 'A reply', sessionId: 'session-one' }
const status = { code: 0, data: { state: 'online', defaults: { tts: 'configured-provider' }, providers: { tts: [{ id: 'configured-provider', enabled: true, model: 'configured-default' }] } } }
function backend(reply = status, synth = () => new Response('RIFF0000WAVE', { headers: { 'content-type': 'audio/wav' } })) {
  const calls = []
  return { calls, resolveManagerBase: async () => 'http://rabi.test', fetch: async (url, init) => {
    calls.push({ url, init })
    return url.endsWith('/status') ? Response.json(reply) : synth()
  } }
}
const play = dependencies => synthesizeRabiSpeech({}, input, new AbortController().signal, dependencies)

test('speech tolerates unrelated degradation but still rejects unready or mismatched Manager identity', async () => {
  const meta = { health: { state: 'degraded', live: true, requiredReady: true }, applicationGenerationId: 'generation', managerInstanceId: 'manager' }
  const deps = { hostStatus: async () => ({ ...meta, managerBaseUrl: 'http://rabi.test' }), fetch: async () => Response.json(meta) }
  const signal = new AbortController().signal
  await assert.rejects(resolveManagerBase({}, signal, deps), /not ready/)
  assert.equal(await resolveManagerBase({}, signal, deps, { allowDegraded: true }), 'http://rabi.test')
  meta.health.requiredReady = false
  await assert.rejects(resolveManagerBase({}, signal, deps, { allowDegraded: true }), /not ready/)
  meta.health.requiredReady = true
  deps.hostStatus = async () => ({ ...meta, managerBaseUrl: 'http://rabi.test', managerInstanceId: 'other' })
  await assert.rejects(resolveManagerBase({}, signal, deps, { allowDegraded: true }), /identities do not match/)
})

test('playback checks service and uses its current default without overriding voice or starting services', async () => {
  const deps = backend()
  assert.deepEqual(await play(deps), { ok: true, audio: Buffer.from('RIFF0000WAVE') })
  assert.deepEqual(deps.calls.map(call => call.url), ['http://rabi.test/api/speech/status', 'http://rabi.test/api/speech/tts'])
  assert.deepEqual(JSON.parse(deps.calls[1].init.body), { input: input.text, model: 'configured-provider/configured-default', play: false, responseFormat: 'wav', sessionId: input.sessionId })
})
test('offline or missing default never sends synthesis', async () => {
  for (const [data, reason] of [[{ state: 'offline' }, 'offline'], [{ state: 'online', defaults: {} }, 'no-default']]) {
    const deps = backend({ code: 0, data })
    assert.equal((await play(deps)).reason, reason)
    assert.equal(deps.calls.length, 1)
  }
})
test('invalid text is rejected before discovery', async () => {
  for (const text of ['', ' ', 'x'.repeat(10001)]) {
    const deps = backend()
    assert.equal((await synthesizeRabiSpeech({}, { ...input, text }, new AbortController().signal, deps)).reason, 'bad-request')
    assert.equal(deps.calls.length, 0)
  }
})
test('invalid audio and failed synthesis are explicit and never replayed', async () => {
  for (const synth of [() => { throw new Error('network lost') }, () => new Response('audio'), () => Response.json({ message: 'failed' }, { status: 503 })]) {
    const deps = backend(status, synth)
    assert.equal((await play(deps)).ok, false)
    assert.equal(deps.calls.length, 2)
  }
})

test('oversized generated audio is rejected without a retry', async () => {
  const deps = backend(status, () => new Response(new Uint8Array(32 * 1024 * 1024 + 1)))
  assert.equal((await play(deps)).reason, 'failed')
  assert.equal(deps.calls.length, 2)
})
test('real HTTP adapter rejects malformed, oversized and cross-origin requests without playback', async t => {
  const deps = backend()
  const server = createServer(createSpeechHandler({}, deps))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}/rabiroute/speech`
  for (const [body, origin, expected] of [['{', undefined, 400], ['x'.repeat(65537), undefined, 413], [JSON.stringify(input), 'http://evil.test', 403], [JSON.stringify(input), 'null', 403]]) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body })
    assert.equal(response.status, expected)
  }
  assert.equal(deps.calls.length, 0)
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  assert.equal(response.headers.get('content-type'), 'audio/wav')
  assert.equal(await response.text(), 'RIFF0000WAVE')
})


test('mini player disables generation, excludes reasoning, seeks without resynthesis and releases audio', async () => {
  const states = [], calls = [], audios = [], revoked = []
  let cursor = 0, finish, cleanup
  class FakeAudio {
    constructor(url) { this.src = url; this.currentTime = 0; this.duration = 20; this.paused = true; audios.push(this) }
    async play() { this.paused = false; this.onplay?.() }
    pause() { this.paused = true; this.onpause?.() }
    removeAttribute() { this.src = '' }
    load() {}
  }
  const context = { AbortController, Error, Number, String, Audio: FakeAudio, URL: { createObjectURL: () => 'blob:test', revokeObjectURL: url => revoked.push(url) }, Button: 'Button', fetch: (url, init) => { calls.push({ url, init }); return new Promise(resolve => { finish = resolve }) }, React: {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value }] },
    useRef: initial => { const i = cursor++; return states[i] ??= { current: initial } },
    useEffect: callback => { if (!cleanup) cleanup = callback() },
  } }
  vm.createContext(context)
  const source = (await readFile(new URL('../src/client-speech.js', import.meta.url), 'utf8')).replace(/^import [^\r\n]*\r?\n/gm, '').replace(/^export /gm, '')
  vm.runInContext(source + '\nthis.render = RabiSpeechAction', context)
  const snapshot = { eventNodes: [{ kind: 'assistant', messageId: 'wanted', blocks: [{ kind: 'reasoning', text: 'Private reasoning' }, { kind: 'text', text: 'The reply' }, { kind: 'tool-call', name: 'test' }] }] }
  const render = () => { cursor = 0; return context.render({ ...input, messageId: 'wanted', useTrajectory: select => select(snapshot), t: key => key }) }
  const button = render().children[0]
  const generating = button.props.onClick()
  await button.props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0].init.body).text, 'The reply')
  assert.equal(render().children[0].props.disabled, true)
  assert.equal(render().children[1].props.role, 'status')
  assert.equal(render().children[1].children[1].props.value, undefined, 'generation progress must not invent a percentage')
  finish(new Response('RIFF0000WAVE', { headers: { 'content-type': 'audio/wav' } }))
  await generating
  const player = render()
  assert.equal(player.props.style.height, 24)
  assert.equal(player.children[0].props['aria-label'], 'pause')
  player.children[2].props.onChange({ target: { value: '8' } })
  assert.equal(audios[0].currentTime, 8)
  await player.children[0].props.onClick()
  assert.equal(audios[0].paused, true)
  await render().children[0].props.onClick()
  assert.equal(audios[0].paused, false)
  assert.equal(calls.length, 1)
  cleanup()
  assert.equal(audios[0].paused, true)
  assert.deepEqual(revoked, ['blob:test'])
})
