import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

test('real React reads each new reply once, queues playback, and cancels late audio on disable or session exit',
  { skip: !process.env.DSH_SOURCE_ROOT }, async () => {
    const require = createRequire(resolve(process.env.DSH_SOURCE_ROOT, 'packages/experimental/client-ui-voice-input/package.json'))
    const React = require('react'), { createRoot } = require('react-dom/client'), { act } = React
    const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true })
    const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
    globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const audios = [], calls = [], revoked = []
    let deferred
    class FakeAudio {
      constructor(url) { this.src = url; this.paused = true; this.duration = 1; this.currentTime = 0; audios.push(this) }
      async play() { this.paused = false; this.onplay?.() }
      pause() { this.paused = true; this.onpause?.() }
      removeAttribute() { this.src = '' }
      load() {}
    }
    const context = { React, Button: 'button', document: dom.window.document, AbortController, Error, Number, String,
      Audio: FakeAudio, URL: { createObjectURL: () => `blob:${audios.length}`, revokeObjectURL: url => revoked.push(url) },
      fetch: async (_url, init) => { calls.push(init); return deferred ? await deferred : new Response('RIFF0000WAVE', { headers: { 'content-type': 'audio/wav' } }) },
    }
    const source = (await Promise.all(['client-speech', 'client-auto-speech'].map(name =>
      readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8'))))
      .map(value => value.replace(/^import [^\r\n]*\r?\n/gmu, '').replace(/^export /gmu, '')).join('\n')
    vm.runInNewContext(source + '\nglobalThis.Component = RabiAutoSpeech', context)
    const root = createRoot(dom.window.document.getElementById('root'))
    const reply = seq => ({ kind: 'assistant', seq, messageId: `reply-${seq}`, blocks: [{ kind: 'text', text: `Reply ${seq}` }, { kind: 'reasoning', text: 'Private' }] })
    let nodes = [reply(1)], enabled = true, sessionId = 'session-one'
    const render = async () => {
      await act(async () => {
        root.render(React.createElement(context.Component, { key: sessionId, sessionId,
          useTrajectory: select => select({ eventNodes: nodes }), useSession: select => select({ openState: 'open' }),
          useRabiAutoRead: select => select(enabled), t: key => key }))
        await new Promise(resolve => setImmediate(resolve))
      })
    }
    try {
      await render()
      assert.equal(calls.length, 0)
      nodes = [...nodes, reply(2)]
      await render()
      assert.equal(calls.length, 1)
      assert.equal(JSON.parse(calls[0].body).text, 'Reply 2')
      assert.equal(audios[0].paused, false)
      await render()
      assert.equal(calls.length, 1)
      nodes = [...nodes, reply(3)]
      await render()
      assert.equal(calls.length, 1, 'next reply waits while the first plays')
      await act(async () => { audios[0].onended(); await new Promise(resolve => setImmediate(resolve)) })
      assert.equal(calls.length, 2)
      assert.equal(audios[0].paused, true)
      assert.equal(audios[1].paused, false)
      enabled = false
      await render()
      assert.equal(audios[1].paused, true)
      enabled = true
      await render()
      assert.equal(calls.length, 2, 'enabling does not read old replies')
      let finish
      deferred = new Promise(resolve => { finish = resolve })
      nodes = [...nodes, reply(4)]
      await render()
      assert.equal(calls.length, 3)
      sessionId = 'session-two'
      await render()
      assert.equal(calls[2].signal.aborted, true)
      await act(async () => { finish(new Response('RIFF0000WAVE', { headers: { 'content-type': 'audio/wav' } })); await new Promise(resolve => setImmediate(resolve)) })
      assert.equal(audios.length, 2, 'late audio is discarded after session exit')
      assert.equal(revoked.length, 2)
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
      globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
    }
  })
