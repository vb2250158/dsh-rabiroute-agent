import * as React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

export const rabiSpeechLocales = {
  zh: { play: '朗读回复', busy: '生成中', pause: '暂停', resume: '播放', seek: '播放进度', failed: '生成失败，请重试', offline: 'Rabi TTS 服务未开启', 'no-default': 'Rabi 未配置默认 TTS', 'bad-request': '回复为空或超过 10000 字符', unreachable: '无法连接 Rabi', rejected: 'Rabi 拒绝了生成请求', playback: '无法播放音频，请重试播放', upgrade: '请重启 DSH 以加载新版语音服务' },
  en: { play: 'Read reply aloud', busy: 'Generating', pause: 'Pause', resume: 'Play', seek: 'Playback position', failed: 'Generation failed. Retry.', offline: 'Rabi TTS is offline', 'no-default': 'No default TTS configured in Rabi', 'bad-request': 'Reply is empty or exceeds 10000 characters', unreachable: 'Cannot connect to Rabi', rejected: 'Rabi rejected synthesis', playback: 'Unable to play audio. Try playing again.', upgrade: 'Restart DSH to load the updated speech service' },
}

/** Extract only the clicked reply body, never reasoning or tool calls. */
export function rabiReplyText(snapshot, messageId) {
  const node = snapshot.eventNodes.find(node => node.kind === 'assistant' && node.messageId === messageId)
  return node?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n\n') || ''
}

export function speechTime(seconds) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

/** Compact browser player; synthesis and voice defaults remain owned by Rabi. */
export function RabiSpeechAction({ sessionId, messageId, useTrajectory, t }) {
  const text = useTrajectory(snapshot => rabiReplyText(snapshot, messageId))
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState(null)
  const [ready, setReady] = React.useState(false)
  const [playing, setPlaying] = React.useState(false)
  const [position, setPosition] = React.useState(0)
  const [duration, setDuration] = React.useState(0)
  const pending = React.useRef(null)
  const media = React.useRef(null)
  const releaseAudio = () => {
    const current = media.current
    if (!current) return
    media.current = null
    current.audio.onloadedmetadata = current.audio.ondurationchange = current.audio.ontimeupdate = current.audio.onplay = current.audio.onpause = current.audio.onended = current.audio.onerror = null
    current.audio.pause()
    current.audio.removeAttribute('src')
    current.audio.load()
    URL.revokeObjectURL(current.url)
  }
  React.useEffect(() => {
    setBusy(false); setNotice(null); setReady(false); setPlaying(false); setPosition(0); setDuration(0)
    return () => { pending.current?.abort(); pending.current = null; releaseAudio() }
  }, [sessionId, messageId])
  const startAudio = async current => {
    try { await current.audio.play() } catch {
      if (media.current === current) { setPlaying(false); setNotice(t('playback')) }
    }
  }
  const play = async () => {
    if (pending.current) return
    if (media.current) {
      setNotice(null)
      if (!media.current.audio.paused) media.current.audio.pause()
      else await startAudio(media.current)
      return
    }
    const controller = new AbortController()
    pending.current = controller
    setBusy(true); setNotice(null)
    try {
      const response = await fetch('/rabiroute/speech', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, sessionId }) })
      if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/wav')) {
        const result = await response.json()
        throw new Error(result.ok ? t('upgrade') : `${t(result.reason in rabiSpeechLocales.en ? result.reason : 'failed')}${result.message ? `: ${result.message}` : ''}`)
      }
      const blob = await response.blob()
      if (pending.current !== controller) return
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      const current = { audio, url }
      media.current = current
      const update = () => {
        if (media.current !== current) return
        setPosition(audio.currentTime)
        setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
        setPlaying(!audio.paused && !audio.ended)
      }
      audio.onloadedmetadata = audio.ondurationchange = audio.ontimeupdate = audio.onplay = audio.onpause = audio.onended = update
      audio.onerror = () => {
        if (media.current !== current) return
        releaseAudio(); setReady(false); setPlaying(false); setNotice(t('playback'))
      }
      setReady(true)
      await startAudio(current)
    } catch (error) {
      if (pending.current === controller) setNotice(error instanceof Error ? error.message : t('failed'))
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }
  if (!text.trim()) return null
  const label = busy ? 'busy' : ready ? playing ? 'pause' : 'resume' : 'play'
  const path = ready ? playing ? 'M8 5v14 M16 5v14' : 'm8 5 11 7-11 7V5Z' : 'M11 5 6 9H3v6h3l5 4V5Z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14'
  return React.createElement('span', { 'data-rabi-speech': true, style: { display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, verticalAlign: 'middle', fontSize: 11 } },
    React.createElement(Button, { size: 'sm', variant: 'ghost', disabled: busy, title: t(label), 'aria-label': t(label), 'aria-busy': busy, onClick: play, style: { height: 24, width: 24, minHeight: 24, padding: 3 } },
      React.createElement('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, React.createElement('path', { d: path }))),
    busy && React.createElement('span', { role: 'status', style: { display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' } }, t('busy'), React.createElement('progress', { 'aria-label': t('busy'), style: { width: 44, height: 4 } })),
    ready && !busy && React.createElement('input', { type: 'range', min: 0, max: duration || 1, step: 0.1, value: position, disabled: !duration, 'aria-label': t('seek'), 'aria-valuetext': `${speechTime(position)} / ${speechTime(duration)}`, style: { width: 84, height: 16, margin: 0, accentColor: 'currentColor', cursor: 'pointer' }, onChange: event => {
      if (!media.current || !duration) return
      const next = Math.min(duration, Math.max(0, Number(event.target.value)))
      media.current.audio.currentTime = next; setPosition(next)
    } }),
    ready && !busy && React.createElement('span', { style: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, `${speechTime(position)}/${speechTime(duration)}`),
    notice && React.createElement('span', { role: 'alert', title: notice, 'aria-label': notice, style: { cursor: 'help' } }, '⚠'))
}
