import * as React from 'react'

export const rabiQuestionLocales = {
  zh: {
    auto: '自动语音输入',
    listening: '监听中 · 跟随 Rabi 配置',
    policy: '静音收尾、音量阈值和自动提交跟随 Rabi',
    changed: '输入内容已改变，已停止自动发送',
    insecure: '录音需要 HTTPS 或本机 localhost',
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
    auto: 'Automatic voice input',
    listening: 'Listening · Rabi settings',
    policy: 'Silence, volume thresholds and auto-submit follow Rabi',
    changed: 'Draft changed; automatic submission stopped',
    insecure: 'Recording requires HTTPS or localhost',
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

/** Browser PCM adapter for Rabi MicrophoneService's threshold/segment rules.
 * All tunables come from the live Manager microphone config, never local defaults.
 */
export function createRabiVoiceGate(config, rate) {
  const keys = ['recordThreshold', 'transcribeThreshold', 'adaptiveMultiplier', 'adaptiveMargin', 'silenceMs', 'minUtteranceMs', 'maxUtteranceMs', 'preRollMs', 'inputGain', 'chunkMs']
  if (!config || keys.some(key => !Number.isFinite(config[key]) || config[key] < 0)
      || config.silenceMs <= 0 || config.maxUtteranceMs <= 0 || config.chunkMs <= 0
      || typeof config.adaptiveThreshold !== 'boolean' || typeof config.autoSubmit !== 'boolean'
      || !Number.isFinite(rate) || rate <= 0) throw new Error('Invalid Rabi microphone configuration')
  let noise = Math.max(0.0005, config.recordThreshold / 3)
  let threshold = config.recordThreshold
  let pre = [], preSize = 0, chunks = [], size = 0, voiced = 0, silence = 0, peak = 0, active = false
  const reset = () => { pre = []; preSize = 0; chunks = []; size = 0; voiced = 0; silence = 0; peak = 0; active = false }
  return {
    reset,
    push(input) {
      const chunk = Float32Array.from(input, value => Math.max(-1, Math.min(1, value * config.inputGain)))
      const level = Math.sqrt(chunk.reduce((sum, value) => sum + value * value, 0) / chunk.length)
      if (!active) {
        if (config.preRollMs > 0) {
          pre.push(chunk); preSize += chunk.length
          while (preSize > Math.round(rate * config.preRollMs / 1000) && pre.length > 1) preSize -= pre.shift().length
        }
        threshold = config.adaptiveThreshold ? Math.max(config.recordThreshold, noise * config.adaptiveMultiplier + config.adaptiveMargin) : config.recordThreshold
        if (level < threshold) { if (config.adaptiveThreshold) noise = noise * 0.95 + level * 0.05; return null }
        active = true; chunks = pre.length ? pre : [chunk]; size = pre.length ? preSize : chunk.length
        pre = []; preSize = 0; peak = level; voiced = chunk.length; silence = 0
        return null
      }
      chunks.push(chunk); size += chunk.length; peak = Math.max(peak, level)
      if (level >= threshold) voiced += chunk.length
      silence = level >= config.transcribeThreshold ? 0 : silence + chunk.length
      if (silence < Math.round(rate * config.silenceMs / 1000) && size < Math.round(rate * config.maxUtteranceMs / 1000)) return null
      let result = null
      if (peak >= config.transcribeThreshold && voiced >= Math.round(rate * config.minUtteranceMs / 1000)) {
        result = new Float32Array(size)
        let offset = 0
        for (const part of chunks) { result.set(part, offset); offset += part.length }
      }
      reset()
      return result
    },
  }
}

function enhanceCustomField(field, { sessionId, t }) {
  if (field.dataset.rabiQuestionEnhanced === 'true') return () => {}
  const box = field.parentNode
  if (!box) return () => {}
  field.dataset.rabiQuestionEnhanced = 'true'
  const previousPosition = box.style.position, previousPadding = field.style.paddingRight
  if (!previousPosition || previousPosition === 'static') box.style.position = 'relative'
  field.style.paddingRight = '36px'
  const button = document.createElement('button')
  button.type = 'button'; button.dataset.rabiQuestionMic = 'true'
  button.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);z-index:5;width:28px;height:28px;border:0;border-radius:999px;padding:0;background:transparent;color:inherit;cursor:pointer;pointer-events:auto;display:inline-flex;align-items:center;justify-content:center'
  box.append(button)
  const panel = document.createElement('div')
  panel.dataset.rabiQuestionAuto = 'true'
  panel.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:6px 0;font-size:12px;color:var(--dsw-alias-label-secondary)'
  const toggle = document.createElement('button')
  toggle.type = 'button'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', t('auto'))
  toggle.title = t('policy')
  toggle.style.cssText = 'width:36px;height:22px;border:1px solid var(--dsw-alias-line-primary);border-radius:11px;padding:2px;cursor:pointer;flex-shrink:0'
  const thumb = document.createElement('span')
  thumb.style.cssText = 'display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform 120ms'
  toggle.append(thumb)
  const label = document.createElement('span'); label.textContent = t('auto')
  const status = document.createElement('span'); status.setAttribute('role', 'status')
  panel.style.gridArea = '2 / 1'
  panel.style.whiteSpace = 'normal'
  panel.append(toggle, label, status); box.append(panel)
  button.style.position = 'relative'
  button.style.gridArea = '1 / 1'
  button.style.alignSelf = 'center'
  button.style.justifySelf = 'end'
  button.style.top = 'auto'
  button.style.transform = 'none'
  let recorder = null, enabled = false, disposed = false, busy = false, generation = 0, abort = null, policyTimer = null
  const setState = key => { button.replaceChildren(micIcon(key === 'stop')); button.title = t(key); button.setAttribute('aria-label', `${t('branch')} · ${t(key)}`) }
  const paint = () => {
    toggle.setAttribute('aria-checked', String(enabled)); thumb.style.transform = enabled ? 'translateX(14px)' : 'translateX(0)'
    toggle.style.background = enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-elevated)'
    button.disabled = enabled || busy
  }
  const release = () => {
    const current = recorder; recorder = null
    if (!current) return
    clearTimeout(current.timer)
    current.processor.disconnect(); current.source.disconnect(); current.mute.disconnect()
    for (const track of current.stream.getTracks()) track.stop()
    void current.context.close().catch(() => {})
  }
  const cancel = () => {
    generation++; enabled = false; busy = false; abort?.abort(); abort = null
    clearInterval(policyTimer); policyTimer = null; release(); paint(); setState('record')
  }
  const fail = message => { cancel(); status.textContent = message }
  const loadPolicy = async signal => {
    const response = await fetch('/rabiroute/speech/asr', { signal, cache: 'no-store' })
    const value = await response.json()
    if (!response.ok || !value.ok) throw new Error(noticeFor(value, t))
    createRabiVoiceGate(value.config, value.config.sampleRate)
    return value
  }
  const transcribe = async (pcm, rate, token, auto, draft) => {
    busy = true; paint(); status.textContent = t('busy'); setState('busy')
    try {
      const wav = encodePcmWav(pcm, rate)
      if (!wav) throw new Error(t('bad-request'))
      const response = await fetch('/rabiroute/speech/asr', { method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, automatic: auto, mimeType: 'audio/wav', audio: bytesToBase64(wav) }) })
      const result = await response.json()
      if (disposed || generation !== token || !field.isConnected) return
      if (!response.ok || !result.ok) throw new Error(noticeFor(result, t))
      if (!result.text?.trim()) throw new Error(t('empty'))
      if (field.value !== draft) throw new Error(t('changed'))
      const policy = auto ? await loadPolicy(abort.signal) : null
      if (disposed || generation !== token || !field.isConnected || field.value !== draft) return
      if (!fillOfficialTextarea(field, result.text)) throw new Error(t('failed'))
      await new Promise(resolve => setTimeout(resolve, 0))
      if (disposed || generation !== token || !field.isConnected) return
      if (auto && policy.config.autoSubmit && field.value === result.text && !field.disabled) {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
      }
      cancel(); status.textContent = ''
    } catch (error) {
      if (generation === token && !disposed) fail(error.name === 'AbortError' ? '' : error.message || t('failed'))
    }
  }
  const start = async auto => {
    const token = ++generation; abort = new AbortController(); busy = true; paint()
    const draft = field.value
    let stream, context
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) throw new Error(t(window.isSecureContext === false ? 'insecure' : 'unsupported'))
      let policy = auto ? await loadPolicy(abort.signal) : null
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (disposed || generation !== token || !field.isConnected) { for (const track of stream.getTracks()) track.stop(); return }
      context = new AudioContext({ sampleRate: auto ? policy.config.sampleRate : 16000 })
      await context.resume()
      if (disposed || generation !== token) { for (const track of stream.getTracks()) track.stop(); await context.close(); return }
      const source = context.createMediaStreamSource(stream), processor = context.createScriptProcessor(4096, 1, 1), mute = context.createGain()
      mute.gain.value = 0
      const samples = []; let pending = [], gate = auto ? createRabiVoiceGate(policy.config, context.sampleRate) : null
      recorder = { stream, context, source, processor, mute, samples, rate: context.sampleRate, timer: null, token, draft }
      processor.onaudioprocess = event => {
        if (!recorder || busy || generation !== token) return
        const data = new Float32Array(event.inputBuffer.getChannelData(0))
        if (!auto) { samples.push(data); return }
        if (policy.config.suppressDuringPlayback && (policy.playbackActive || [...document.querySelectorAll('audio,video')].some(media => !media.paused))) { gate.reset(); pending = []; return }
        pending.push(...data)
        const length = Math.max(1, Math.round(context.sampleRate * policy.config.chunkMs / 1000))
        while (pending.length >= length) {
          const phrase = gate.push(pending.splice(0, length))
          if (phrase) { release(); clearInterval(policyTimer); policyTimer = null; void transcribe(phrase, context.sampleRate, token, true, draft); return }
        }
      }
      source.connect(processor); processor.connect(mute); mute.connect(context.destination)
      busy = false; paint(); setState('stop'); status.textContent = auto ? t('listening') : ''
      if (auto) {
        let refreshing = false
        policyTimer = setInterval(async () => {
          if (refreshing) return
          refreshing = true
          try {
            const next = await loadPolicy(abort.signal)
            if (generation !== token || !recorder) return
            if (JSON.stringify(next.config) !== JSON.stringify(policy.config)) { gate = createRabiVoiceGate(next.config, context.sampleRate); pending = [] }
            policy = next
          } catch (error) { if (generation === token) fail(error.message || t('failed')) }
          finally { refreshing = false }
        }, 1000)
      } else recorder.timer = setTimeout(() => { if (generation === token && recorder) button.click() }, 20000)
    } catch (error) {
      if (stream) for (const track of stream.getTracks()) track.stop()
      if (context && context.state !== 'closed') void context.close().catch(() => {})
      if (generation === token && !disposed) fail(error.name === 'NotAllowedError' ? t('denied') : error.message || t('failed'))
    }
  }
  button.onclick = event => {
    event.preventDefault(); event.stopPropagation()
    if (busy || enabled) return
    if (recorder) {
      const current = recorder, length = current.samples.reduce((sum, part) => sum + part.length, 0)
      const pcm = new Float32Array(length); let offset = 0
      for (const part of current.samples) { pcm.set(part, offset); offset += part.length }
      release(); void transcribe(pcm, current.rate, current.token, false, current.draft)
    } else void start(false)
  }
  toggle.onclick = event => {
    event.preventDefault(); event.stopPropagation()
    if (enabled) { cancel(); status.textContent = ''; return }
    cancel(); enabled = true; paint(); void start(true)
  }
  const onDraft = event => { if (event.isTrusted && (enabled || busy)) fail(t('changed')) }
  const onHidden = () => { if (document.hidden) { cancel(); status.textContent = '' } }
  field.addEventListener('input', onDraft); document.addEventListener('visibilitychange', onHidden)
  setState('record'); paint()
  return () => {
    disposed = true; cancel(); button.onclick = null; toggle.onclick = null
    field.removeEventListener('input', onDraft); document.removeEventListener('visibilitychange', onHidden)
    panel.remove(); button.remove(); box.style.position = previousPosition; field.style.paddingRight = previousPadding
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
