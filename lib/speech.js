import { resolveManagerBase } from './connection.js'

export const SPEECH_PATH = '/rabiroute/speech'

/** Synthesize with Rabi's defaults and return a bounded WAV for the requesting browser. */
export async function synthesizeRabiSpeech(config, input, signal, dependencies = {}) {
  if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 10000
    || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 200) {
    return { ok: false, reason: 'bad-request' }
  }
  const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.floor(Math.min(900000, Math.max(1000, Number(config.speechTimeoutMs) || 300000))))])
  let submitted = false
  try {
    const base = await (dependencies.resolveManagerBase || resolveManagerBase)(config, operationSignal, dependencies, { allowDegraded: true })
    const fetcher = dependencies.fetch || globalThis.fetch
    const statusResponse = await fetcher(base + '/api/speech/status', { signal: operationSignal, redirect: 'error' })
    const status = await statusResponse.json()
    if (!statusResponse.ok || status.code !== 0) throw new Error(status.message || `HTTP ${statusResponse.status}`)
    if (status.data?.state !== 'online') return { ok: false, reason: 'offline' }
    const provider = status.data?.providers?.tts?.find(provider => provider.id === status.data?.defaults?.tts)
    if (!provider?.enabled || typeof provider.model !== 'string' || !provider.model.trim()) return { ok: false, reason: 'no-default' }
    const model = `${provider.id}/${provider.model}`
    operationSignal.throwIfAborted()
    submitted = true
    const response = await fetcher(base + '/api/speech/tts', {
      method: 'POST', signal: operationSignal, redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: input.text, model, play: false, responseFormat: 'wav', sessionId: input.sessionId }),
    })
    if (!response.ok) {
      const error = await response.json()
      return { ok: false, reason: 'rejected', message: error.message || (typeof error.detail === 'string' ? error.detail : `HTTP ${response.status}`) }
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No audio returned')
    const chunks = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 32 * 1024 * 1024) throw new Error('Audio exceeds 32 MiB')
        chunks.push(value)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    const audio = Buffer.concat(chunks)
    if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Rabi did not return WAV audio')
    return { ok: true, audio }
  } catch (error) {
    return { ok: false, reason: submitted ? 'failed' : 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
}

/** Same-origin synthesis adapter. Audio is not persisted by DSH or sent to the host queue. */
export function createSpeechHandler(config, dependencies = {}) {
  return async (request, response) => {
    const send = (status, data) => {
      if (response.destroyed) return
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(data))
    }
    if (request.method !== 'POST') return send(405, { ok: false, reason: 'bad-request' })
    if (request.headers.origin) {
      try {
        if (new URL(request.headers.origin).host !== request.headers.host) return send(403, { ok: false, reason: 'bad-request' })
      } catch { return send(403, { ok: false, reason: 'bad-request' }) }
    }
    if (!request.headers['content-type']?.startsWith('application/json')) return send(415, { ok: false, reason: 'bad-request' })
    const controller = new AbortController()
    response.on('close', () => { if (!response.writableEnded) controller.abort() })
    try {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 64 * 1024) return send(413, { ok: false, reason: 'bad-request' })
        chunks.push(chunk)
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const result = await synthesizeRabiSpeech(config, input, controller.signal, dependencies)
      if (!result.ok) return send(200, result)
      if (response.destroyed) return
      response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': result.audio.length, 'cache-control': 'no-store' })
      response.end(result.audio)
    } catch {
      // Malformed or interrupted request bodies cannot submit speech.
      send(400, { ok: false, reason: 'bad-request' })
    }
  }
}
