import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { transcribeRabiSpeech, createAsrHandler } from '../src/speech-asr.js'

const sessionId = 'session-one'
const audio = Buffer.from('RIFF0000WAVE').toString('base64')
const input = { sessionId, mimeType: 'audio/wav', audio }
const status = { code: 0, data: { state: 'online', defaults: { asr: 'faster-whisper' }, providers: { asr: [{ id: 'faster-whisper', enabled: true, model: 'small' }] } } }

function backend(reply = status, asr = () => Response.json({ text: '自己的分支' })) {
  const calls = []
  return { calls, resolveManagerBase: async () => 'http://rabi.test', fetch: async (url, init) => {
    calls.push({ url, init })
    return url.endsWith('/status') ? Response.json(reply) : asr(init)
  } }
}

test('transcription uses Rabi default ASR and does not start services', async () => {
  const deps = backend()
  assert.deepEqual(await transcribeRabiSpeech({}, input, new AbortController().signal, deps), { ok: true, text: '自己的分支' })
  assert.deepEqual(deps.calls.map(call => call.url), ['http://rabi.test/api/speech/status', 'http://rabi.test/api/speech/asr'])
  assert.equal(deps.calls[1].init.body instanceof FormData, true)
  assert.equal(deps.calls[1].init.body.get('model'), 'faster-whisper/small')
  assert.equal(deps.calls[1].init.body.get('language'), 'zh')
  assert.equal(deps.calls[1].init.body.get('session_id'), sessionId)
})

test('offline or missing default never sends audio', async () => {
  for (const [data, reason] of [[{ state: 'offline' }, 'offline'], [{ state: 'online', defaults: {} }, 'no-default']]) {
    const deps = backend({ code: 0, data })
    assert.equal((await transcribeRabiSpeech({}, input, new AbortController().signal, deps)).reason, reason)
    assert.equal(deps.calls.length, 1)
  }
})

test('invalid audio is rejected before discovery', async () => {
  const deps = backend()
  for (const broken of [{}, { ...input, audio: '' }, { ...input, mimeType: 'video/mp4' }, { ...input, sessionId: '' }]) {
    assert.equal((await transcribeRabiSpeech({}, broken, new AbortController().signal, deps)).reason, 'bad-request')
    assert.equal(deps.calls.length, 0)
  }
})

test('empty or rejected transcripts stay explicit', async () => {
  for (const [asr, reason] of [[() => Response.json({ text: '  ' }), 'empty'], [() => Response.json({ message: 'busy' }, { status: 503 }), 'rejected']]) {
    const deps = backend(status, asr)
    assert.equal((await transcribeRabiSpeech({}, input, new AbortController().signal, deps)).ok, false)
    assert.equal((await transcribeRabiSpeech({}, input, new AbortController().signal, deps)).reason, reason)
  }
})

test('same-origin adapter rejects malformed and cross-origin ASR bodies', async t => {
  const deps = backend()
  const server = createServer(createAsrHandler({}, deps))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}/rabiroute/speech/asr`
  for (const [body, origin, expected] of [['{', undefined, 400], ['x'.repeat(3 * 1024 * 1024 + 1), undefined, 413], [JSON.stringify(input), 'http://evil.test', 403]]) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body })
    assert.equal(response.status, expected)
  }
  assert.equal(deps.calls.length, 0)
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  assert.deepEqual(await response.json(), { ok: true, text: '自己的分支' })
})
