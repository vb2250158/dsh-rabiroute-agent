import * as React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

export const rabiSpeechLocales = {
  zh: { play: '朗读回复', busy: '正在提交朗读', queued: '已加入 Rabi 播放队列', offline: 'Rabi TTS 服务未开启', 'no-default': 'Rabi 未配置默认 TTS', 'bad-request': '回复为空或超过 10000 字符', unreachable: '无法连接 Rabi', rejected: 'Rabi 拒绝了朗读请求', uncertain: '播放结果未确认，请先检查 Rabi 播放队列，避免重复播放' },
  en: { play: 'Read reply aloud', busy: 'Submitting speech', queued: 'Added to Rabi playback queue', offline: 'Rabi TTS is offline', 'no-default': 'No default TTS configured in Rabi', 'bad-request': 'Reply is empty or exceeds 10000 characters', unreachable: 'Cannot connect to Rabi', rejected: 'Rabi rejected the speech request', uncertain: 'Playback outcome is unknown. Check the Rabi queue before retrying.' },
}

/** Read only finalized text blocks belonging to the clicked message, excluding reasoning and tool calls. */
export function rabiReplyText(snapshot, messageId) {
  const node = snapshot.eventNodes.find(node => node.kind === 'assistant' && node.messageId === messageId)
  return node?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n\n') || ''
}

/** Speaker action in the native assistant footer. Rabi owns synthesis and host playback. */
export function RabiSpeechAction({ sessionId, messageId, useTrajectory, t }) {
  const text = useTrajectory(snapshot => rabiReplyText(snapshot, messageId))
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState(null)
  const pending = React.useRef(null)
  React.useEffect(() => () => { pending.current?.abort(); pending.current = null }, [sessionId, messageId])
  const play = async () => {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setNotice(null)
    try {
      const response = await fetch('/rabiroute/speech', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, sessionId }) })
      const result = await response.json()
      if (pending.current === controller) setNotice({ error: !result.ok, text: result.ok ? t('queued') : `${t(result.reason in rabiSpeechLocales.en ? result.reason : 'rejected')}${result.message ? `: ${result.message}` : ''}` })
    } catch {
      if (pending.current === controller) setNotice({ error: true, text: t('uncertain') })
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }
  if (!text.trim()) return null
  return React.createElement('span', { 'data-rabi-speech': true, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
    React.createElement(Button, { size: 'sm', variant: 'ghost', disabled: busy, title: t(busy ? 'busy' : 'play'), 'aria-label': t(busy ? 'busy' : 'play'), 'aria-busy': busy, onClick: play },
      React.createElement('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        React.createElement('path', { d: 'M11 5 6 9H3v6h3l5 4V5Z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14' }))),
    notice && React.createElement('span', { role: notice.error ? 'alert' : 'status' }, notice.text))
}
