import * as React from 'react'

export const rabiQuestionLocales = {
  zh: {
    branch: '自己的分支',
    record: '语音输入',
    stop: '停止录音',
    busy: '识别中',
    denied: '没有麦克风权限',
    empty: '没有识别到内容',
    offline: 'Rabi ASR 服务未开启',
    'no-default': 'Rabi 未配置默认 ASR',
    'bad-request': '录音无效或过长',
    unreachable: '无法连接 Rabi',
    rejected: 'Rabi 拒绝了识别请求',
    failed: '识别失败，请重试',
    unsupported: '当前浏览器不能录音',
  },
  en: {
    branch: 'Your own branch',
    record: 'Voice input',
    stop: 'Stop recording',
    busy: 'Transcribing',
    denied: 'Microphone permission denied',
    empty: 'Nothing was recognized',
    offline: 'Rabi ASR is offline',
    'no-default': 'No default ASR configured in Rabi',
    'bad-request': 'Recording is empty or too large',
    unreachable: 'Cannot connect to Rabi',
    rejected: 'Rabi rejected transcription',
    failed: 'Transcription failed. Retry.',
    unsupported: 'This browser cannot record audio',
  },
}

export function encodePcmWav(float32, sampleRate) {
  const rate = Math.floor(Number(sampleRate) || 0)
  if (!float32 || !Number.isInteger(float32.length) || rate < 8000 || rate > 48000) return null
  const pcm = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i] || 0))
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  const bytes = pcm.length * 2
  const buffer = new ArrayBuffer(44 + bytes)
  const view = new DataView(buffer)
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)) }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, bytes, true)
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer))
  return new Uint8Array(buffer)
}

export function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Write into the official controlled textarea without replacing the composer. */
export function fillOfficialTextarea(textarea, text) {
  if (!textarea || typeof text !== 'string') return false
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set
  if (!setter) return false
  setter.call(textarea, text)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  return textarea.value === text
}

function noticeFor(result, t) {
  if (result?.ok) return ''
  const reason = result?.reason && result.reason in rabiQuestionLocales.en ? result.reason : 'failed'
  return `${t(reason)}${result?.message ? `: ${result.message}` : ''}`
}

function micIcon(recording) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', recording ? 'M8 8h8v8H8z' : 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm5 8a5 5 0 0 1-10 0M12 16v4M8 21h8')
  svg.append(path)
  return svg
}

function enhanceCustomField(field, { sessionId, t }) {
  if (field.dataset.rabiQuestionEnhanced === 'true') return () => {}
  field.dataset.rabiQuestionEnhanced = 'true'
  const box = field.parentNode
  if (!box) return () => {}
  const previousPosition = box.style.position
  const previousPadding = field.style.paddingRight
  if (!previousPosition || previousPosition === 'static') box.style.position = 'relative'
  field.style.paddingRight = '36px'
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.rabiQuestionMic = 'true'
  button.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);z-index:5;width:28px;height:28px;border:0;border-radius:999px;padding:0;background:transparent;color:inherit;cursor:pointer;pointer-events:auto;display:inline-flex;align-items:center;justify-content:center'
  box.append(button)
  let recorder = null
  const setState = key => {
    button.replaceChildren(micIcon(key === 'stop'))
    button.title = t(key)
    button.setAttribute('aria-label', `${t('branch')} · ${t(key)}`)
  }
  setState('record')
  const stopTracks = stream => { for (const track of stream.getTracks()) track.stop() }
  const finish = async (stream, context, samples, rate) => {
    stopTracks(stream)
    await context.close().catch(() => {})
    const length = samples.reduce((sum, chunk) => sum + chunk.length, 0)
    const pcm = new Float32Array(length)
    let offset = 0
    for (const chunk of samples) { pcm.set(chunk, offset); offset += chunk.length }
    const wav = encodePcmWav(pcm, rate)
    if (!wav) { setState('record'); button.title = t('bad-request'); return }
    setState('busy')
    const response = await fetch('/rabiroute/speech/asr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, mimeType: 'audio/wav', audio: bytesToBase64(wav) }),
    })
    const result = await response.json()
    if (!result?.ok) { setState('record'); button.title = noticeFor(result, t); return }
    fillOfficialTextarea(field, result.text)
    setState('record')
  }
  button.onclick = async event => {
    event.preventDefault()
    event.stopPropagation()
    if (recorder) {
      recorder.processor.disconnect()
      recorder.source.disconnect()
      recorder.mute.disconnect()
      const current = recorder
      recorder = null
      await finish(current.stream, current.context, current.samples, current.rate)
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      button.title = t('unsupported')
      return
    }
    let stream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { button.title = t('denied'); return }
    const context = new AudioContext({ sampleRate: 16000 })
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const mute = context.createGain()
    mute.gain.value = 0
    const samples = []
    processor.onaudioprocess = event => { samples.push(new Float32Array(event.inputBuffer.getChannelData(0))) }
    source.connect(processor)
    processor.connect(mute)
    mute.connect(context.destination)
    recorder = { stream, context, source, processor, mute, samples, rate: context.sampleRate || 16000 }
    setState('stop')
    window.setTimeout(() => { if (recorder && button.isConnected) button.click() }, 20000)
  }
  return () => {
    button.onclick = null
    if (recorder) {
      recorder.processor.disconnect()
      recorder.source.disconnect()
      recorder.mute.disconnect()
      stopTracks(recorder.stream)
      recorder.context.close().catch(() => {})
      recorder = null
    }
    button.remove()
    box.style.position = previousPosition
    field.style.paddingRight = previousPadding
    delete field.dataset.rabiQuestionEnhanced
  }
}

export function isOfficialQuestionField(field) {
  return field?.placeholder === '输入你的答案' || field?.placeholder === 'Type your answer'
}

export function attachRabiQuestionExtras(root, options) {
  if (!root || typeof root.querySelectorAll !== 'function') return () => {}
  const cleanups = new Map()
  const sync = () => {
    const fields = [...root.querySelectorAll('textarea')].filter(field => options?.all || isOfficialQuestionField(field) || root.dataset?.rabiQuestion === 'true')
    for (const [field, cleanup] of cleanups) {
      if (!field.isConnected || !fields.includes(field)) { cleanup(); cleanups.delete(field) }
    }
    for (const field of fields) {
      if (!cleanups.has(field)) cleanups.set(field, enhanceCustomField(field, options))
    }
  }
  sync()
  if (typeof MutationObserver !== 'function' || typeof root.querySelectorAll !== 'function') {
    return () => { for (const cleanup of cleanups.values()) cleanup() }
  }
  const observer = new MutationObserver(sync)
  observer.observe(root, { childList: true, subtree: true })
  return () => { observer.disconnect(); for (const cleanup of cleanups.values()) cleanup() }
}

/** Keep the official composer; mark the custom branch and add Rabi ASR. */
export function RabiQuestionComposer({ Official, rabiQuestionT, ...props }) {
  const root = React.useRef(null)
  React.useEffect(() => attachRabiQuestionExtras(root.current, { sessionId: props.sessionId, t: rabiQuestionT }), [props.matched?.key, props.sessionId, rabiQuestionT])
  return React.createElement('div', { ref: root, 'data-rabi-question': true }, React.createElement(Official, props))
}

export function officialQuestionComposer(entries) {
  return entries.find(entry => entry.options.locale === 'question' && entry.options.priority !== -10)
}

export function registerRabiQuestionComposer(ctx) {
  ctx.effect(() => ctx.locale.register('rabiroute-question', rabiQuestionLocales))
  ctx.effect(() => {
    const root = typeof document === 'undefined' ? null : document.querySelector('[data-composer-seat]') || document.body
    if (!root) return () => {}
    return attachRabiQuestionExtras(root, { sessionId: 'composer', t: ctx.locale.bind('rabiroute-question') })
  })
  ctx.slots.inject('conversation.composer', () => {
    let dispose
    const wrap = () => {
      if (dispose) return
      const original = officialQuestionComposer(ctx.slots.entries('conversation.composer'))
      if (!original) return
      dispose = ctx.slots.register({
        name: 'conversation.composer',
        priority: -10,
        locale: original.options.locale,
        select: original.options.select,
        store: original.options.store,
        inject: sessionId => ({ ...(typeof original.inject === 'function' ? original.inject(sessionId) : {}), rabiQuestionT: ctx.locale.bind('rabiroute-question') }),
      }, props => React.createElement(RabiQuestionComposer, { ...props, Official: original.component, key: props.matched?.key }))
    }
    wrap()
    const timer = dispose || typeof setInterval !== 'function' ? undefined : setInterval(wrap, 100)
    return () => { if (timer !== undefined && typeof clearInterval === 'function') clearInterval(timer); dispose?.() }
  })
}
