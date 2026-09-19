import { resolveManagerBase } from './connection.js'

export const SPEECH_ASR_PATH = '/rabiroute/speech/asr'
const MAX_AUDIO_BYTES = 2 * 1024 * 1024
const MAX_JSON_BYTES = 3 * 1024 * 1024

function asrModelFromStatus(status) {
  const provider = status.data?.providers?.asr?.find(item => item.id === status.data?.defaults?.asr)
  if (!provider?.enabled || typeof provider.model !== 'string' || !provider.model.trim()) return ''
  return `${provider.id}/${provider.model}`
}

function decodeAudio(input) {
  if (!input || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 200) return null
  if (typeof input.mimeType !== 'string' || !input.mimeType.startsWith('audio/') || input.mimeType.length > 80) return null
  if (typeof input.audio !== 'string' || !input.audio) return null
  let buffer
  try { buffer = Buffer.from(input.audio, 'base64') } catch { return null }
  if (!buffer.length || buffer.length > MAX_AUDIO_BYTES) return null
  if (buffer.toString('base64') !== input.audio.replace(/\s/g, '')) return null
  return { sessionId: input.sessionId, mimeType: input.mimeType, audio: buffer }
}

/** Transcribe with Rabi's current default ASR. DSH does not pick or start models. */
export async function transcribeRabiSpeech(config, input, signal, dependencies = {}) {
  const decoded = decodeAudio(input)
  if (!decoded) return { ok: false, reason: 'bad-request' }
  const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.floor(Math.min(900000, Math.max(1000, Number(config.speechTimeoutMs) || 300000))))])
  let submitted = false
  try {
    const base = await (dependencies.resolveManagerBase || resolveManagerBase)(config, operationSignal, dependencies, { allowDegraded: true })
    const fetcher = dependencies.fetch || globalThis.fetch
    const statusResponse = await fetcher(base + '/api/speech/status', { signal: operationSignal, redirect: 'error' })
    const status = await statusResponse.json()
    if (!statusResponse.ok || status.code !== 0) throw new Error(status.message || `HTTP ${statusResponse.status}`)
    if (status.data?.state !== 'online') return { ok: false, reason: 'offline' }
    const model = asrModelFromStatus(status)
    if (!model) return { ok: false, reason: 'no-default' }
    const form = new FormData()
    form.append('file', new Blob([decoded.audio], { type: decoded.mimeType }), decoded.mimeType.includes('wav') ? 'answer.wav' : 'answer.webm')
    form.append('model', model)
    form.append('language', 'zh')
    form.append('session_id', decoded.sessionId)
    form.append('response_format', 'json')
    operationSignal.throwIfAborted()
    submitted = true
    const response = await fetcher(base + '/api/speech/asr', { method: 'POST', signal: operationSignal, redirect: 'error', body: form })
    const payload = await response.json()
    if (!response.ok) {
      return { ok: false, reason: 'rejected', message: payload.message || payload.detail || `HTTP ${response.status}` }
    }
    const text = typeof payload.text === 'string' ? payload.text.trim()
      : typeof payload.data?.text === 'string' ? payload.data.text.trim() : ''
    if (!text) return { ok: false, reason: 'empty' }
    return { ok: true, text }
  } catch (error) {
    return { ok: false, reason: submitted ? 'failed' : 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
}

/** Same-origin ASR adapter. Audio is not persisted by DSH. */
export function createAsrHandler(config, dependencies = {}) {
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
        if (size > MAX_JSON_BYTES) return send(413, { ok: false, reason: 'bad-request' })
        chunks.push(chunk)
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      send(200, await transcribeRabiSpeech(config, input, controller.signal, dependencies))
    } catch {
      send(400, { ok: false, reason: 'bad-request' })
    }
  }
}
