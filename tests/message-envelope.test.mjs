import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRabiMessageEnvelope as parse } from '../src/message-envelope.js'

const current = ['类型：Agent｜处理端：dsh', '角色：example-role', '会话：example-session', '会话 ID：example-session-id', '工作目录：/synthetic/workspace', '投递时间：2000-01-02 03:04:05']
const legacy = ['消息源类型：Agent', 'Agent 端：codex', '会话名称：example-session', '会话 ID：example-session-id', '消息包发送时间：2000-01-02 03:04:05']
const envelope = (body = 'example body', header = current, eol = '\n') => ['[消息源]', ...header, '', '[消息内容]', body].join(eol)
const reply = { deliveryId: 'example-delivery-id', responsePolicy: 'required', requestId: 'example-request-id', request: { action: 'send', threadId: 'example-target-id' }, extra: { list: [1, false, null] } }
const suffix = (value = reply, eol = '\n') => eol + eol + '[回传参数]' + eol + JSON.stringify(value, null, 2).replaceAll('\n', eol)

test('current envelope projects sender, exact raw, body and inert reply JSON', () => {
  const body = 'first line\n\nsecond line\n类型：ordinary body label\n会话 ID：not-metadata'
  const raw = envelope(body + suffix())
  const result = parse(raw)
  assert.equal(result.raw, raw)
  assert.equal(result.body, body)
  assert.equal(result.sourceType, 'agent')
  assert.deepEqual(result.sender, { type: 'agent', agentAdapter: 'dsh', agentType: 'example-role', sessionName: 'example-session', sessionId: 'example-session-id', workspace: '/synthetic/workspace' })
  assert.equal(result.sentAt, '2000-01-02 03:04:05')
  assert.deepEqual(result.replyParameters, reply)
  assert.deepEqual(Object.keys(result).sort(), ['body', 'raw', 'replyParameters', 'sender', 'sentAt', 'sourceType'])
})

test('legacy aliases, ASCII delimiters and CRLF preserve exact body', () => {
  for (const header of [current, legacy]) {
    for (const ascii of [false, true]) {
      for (const eol of ['\n', '\r\n']) {
        const formatted = header.map(line => ascii ? line.replaceAll('：', ':').replaceAll('｜', '|') : line)
        const body = '  leading' + eol + eol + 'middle\n mixed\r\n  trailing  ' + eol
        const raw = envelope(body + suffix({ deliveryId: 'example-delivery-id', responsePolicy: 'none' }, eol), formatted, eol)
        assert.equal(parse(raw).body, body)
        assert.equal(parse(raw).raw, raw)
        assert.equal(parse(raw).sender.sessionId, 'example-session-id')
      }
    }
  }
})

test('optional fields can be absent and unknown adapters remain untrusted metadata', () => {
  const header = current.filter(line => !/^(角色|工作目录)/.test(line)).map(line => line.replace('dsh', 'example-adapter'))
  const result = parse(envelope('body', header))
  assert.equal(result.sender.agentAdapter, 'example-adapter')
  assert.equal(Object.hasOwn(result.sender, 'agentType'), false)
  assert.equal(Object.hasOwn(result.sender, 'workspace'), false)
  assert.equal(result.replyParameters, null)
})

test('no suffix preserves every body character including control characters and empty body', () => {
  for (const body of ['', '\n', '\r\n\r\n', ' \t\n body\n\n ', '\u0000\u001b\u007f\u0085\u2028\u202e\r\n']) {
    const raw = envelope(body)
    assert.equal(parse(raw).body, body)
    assert.equal(parse(raw).raw, raw)
  }
  assert.equal(parse(envelope('').slice(0, -1)).body, '')
})

test('reserved labels, nested envelope and other context/control blocks remain body', () => {
  for (const body of ['[消息源]\n会话：body\n\n[消息内容]\ntext', 'inline [回传参数] is prose', '> [回传参数]\n{}', 'body\n\n[相关上下文]\n\ncontext\n\n[其他控制]\ncontrol']) {
    assert.equal(parse(envelope(body)).body, body)
    assert.equal(parse(envelope(body + suffix())).body, body)
  }
})

test('only exact leading source and content markers with documented separation match', () => {
  const raw = envelope()
  for (const invalid of [null, undefined, 12, {}, new String(raw), '', 'prefix\n' + raw, ' ' + raw, '\ufeff' + raw, raw.replace('[消息源]', '［消息源］'), raw.replace('[消息内容]', '[消息内容] '), raw.replace('\n\n[消息内容]', '\n[消息内容]'), raw.replace('\n\n[消息内容]', '\n\n\n[消息内容]'), raw.replace('[消息内容]', '[other]'), raw.replaceAll('\n', '\r')]) {
    assert.equal(parse(invalid), null)
  }
})

test('missing, blank, malformed, unknown and duplicate header fields fail closed', () => {
  for (const required of ['类型', '处理端', '会话', '会话 ID', '投递时间']) {
    const expanded = current.flatMap(line => line.split('｜'))
    const missing = expanded.filter(line => !line.startsWith(required + '：'))
    assert.equal(parse(envelope('body', missing)), null, required)
    assert.equal(parse(envelope('body', expanded.map(line => line.startsWith(required + '：') ? required + '：   ' : line))), null, required)
  }
  for (const extra of ['会话：example-session', '会话名称：different-session', '消息源类型：Agent', 'Agent 端：dsh', '消息包发送时间：2000-01-02', '投递时间：2000-01-02 03:04:05', '未知字段：body text', 'ordinary header text', '角色：', '工作目录：']) {
    assert.equal(parse(envelope('body', [...current, extra])), null, extra)
  }
  assert.equal(parse(envelope('body', current.map(line => line.replace('｜', '｜unknown：value｜')))), null)
})

test('unknown or unsupported message source types still fall back to raw rendering', () => {
  // `消息端` is a real producer kind this renderer has no presentation for yet,
  // and every unrecognized spelling must stay conservative. `系统` and `计划`
  // are projected, so they are asserted by their own tests below.
  for (const type of ['消息端', 'agent', 'Unknown', '', ' ']) {
    assert.equal(parse(envelope('body', legacy.map(line => line.replace('消息源类型：Agent', '消息源类型：' + type)))), null)
  }
})

test('system envelope projects the event with no sender and no navigation target', () => {
  const header = [
    '消息源类型：系统',
    '事件类型：agent_request_reminder',
    '事件名称：Agent 回复提醒',
    '事件 ID：035c7d05-83c9-478d-ad9f-b7a15ffd4c31',
    '消息包发送时间：2026/9/16 22:15:17',
    '投递 ID：72f9f8d-46f9-41dd-bacf-8a9fc19d0cd9',
  ]
  const body = '[Rabi Agent 请求回复提醒]\n原请求时间：2026-09-16T12:48:36.023Z'
  const result = parse(envelope(body, header))
  assert.equal(result.sourceType, 'system')
  assert.equal(result.sender, null)
  assert.deepEqual(result.event, { eventType: 'agent_request_reminder', eventName: 'Agent 回复提醒', eventId: '035c7d05-83c9-478d-ad9f-b7a15ffd4c31' })
  assert.equal(result.body, body)
  assert.equal(result.deliveryId, '72f9f8d-46f9-41dd-bacf-8a9fc19d0cd9')
  // A route is optional metadata; a system envelope that names no session keeps
  // every identity field absent rather than defaulting to a guessable target.
  assert.deepEqual(Object.keys(result).sort(), ['body', 'deliveryId', 'event', 'raw', 'replyParameters', 'sender', 'sentAt', 'sourceType'])
})

test('system envelope accepts optional actor and route fields', () => {
  const header = [
    '消息源类型：系统', '事件类型：agent_request_reminder', '事件名称：Agent 回复提醒', '事件 ID：event-id',
    '触发方类型：agent', '触发方名称：sender-session', '触发方 ID：sender-id',
    '消息路线：main', '消息路线 ID：route-id', '消息包发送时间：2000-01-02 03:04:05',
  ]
  const result = parse(envelope('body', header))
  assert.equal(result.sender, null)
  assert.deepEqual(result.event, {
    eventType: 'agent_request_reminder', eventName: 'Agent 回复提醒', eventId: 'event-id',
    actorType: 'agent', actorName: 'sender-session', actorId: 'sender-id',
    routeName: 'main', routeId: 'route-id',
  })
})

test('system envelope requires its own fields and rejects a partial or mixed header', () => {
  const system = ['消息源类型：系统', '事件类型：agent_request_reminder', '事件名称：Agent 回复提醒', '事件 ID：event-id', '消息包发送时间：2000-01-02 03:04:05']
  for (const required of ['事件类型', '事件名称', '事件 ID', '消息包发送时间']) {
    assert.equal(parse(envelope('body', system.filter(line => !line.startsWith(required + '：')))), null, required)
  }
  // A field from another kind on a system header is not a shape the producer
  // writes, so it must not silently pick a label from ambiguous data.
  for (const foreign of ['会话：example-session', '会话 ID：example-session-id', '处理端：dsh', '计划名称：plan', '计划 ID：plan-id', '发送者名称：someone']) {
    assert.equal(parse(envelope('body', [...system, foreign])), null, foreign)
  }
})

test('plan envelope projects the plan, keeping any appended source agent locatable', () => {
  const bare = parse(envelope('body', ['消息源类型：计划', '计划名称：示例计划', '计划 ID：plan-abc', '消息包发送时间：2000-01-02 03:04:05']))
  assert.equal(bare.sourceType, 'plan')
  assert.equal(bare.sender, null)
  assert.deepEqual(bare.plan, { planName: '示例计划', planId: 'plan-abc' })

  const withSource = parse(envelope('body', [
    '消息源类型：计划', '计划名称：示例计划', '计划 ID：plan-abc',
    '处理端：dsh', '会话：example-session', '会话 ID：example-session-id', '工作目录：/synthetic/workspace',
    '消息包发送时间：2000-01-02 03:04:05',
  ]))
  assert.equal(withSource.sender, null)
  assert.deepEqual(withSource.plan, {
    planName: '示例计划', planId: 'plan-abc',
    sourceAgent: { type: 'agent', agentAdapter: 'dsh', sessionName: 'example-session', sessionId: 'example-session-id', workspace: '/synthetic/workspace' },
  })
})

test('plan envelope requires its own fields and rejects a half-written source identity', () => {
  const plan = ['消息源类型：计划', '计划名称：示例计划', '计划 ID：plan-abc', '消息包发送时间：2000-01-02 03:04:05']
  for (const required of ['计划名称', '计划 ID', '消息包发送时间']) {
    assert.equal(parse(envelope('body', plan.filter(line => !line.startsWith(required + '：')))), null, required)
  }
  // Half an identity is a malformed record, not a partial one: the producer
  // either appends the complete source agent or omits it entirely.
  for (const partial of [['处理端：dsh'], ['会话：example-session'], ['会话 ID：example-session-id'], ['处理端：dsh', '会话：example-session']]) {
    assert.equal(parse(envelope('body', [...plan, ...partial])), null, partial.join('+'))
  }
  for (const foreign of ['事件类型：x', '事件名称：x', '事件 ID：x', '发送者名称：x', '消息端：x']) {
    assert.equal(parse(envelope('body', [...plan, foreign])), null, foreign)
  }
})

test('control and bidi characters in metadata cause fallback rather than sanitization', () => {
  for (const char of ['\u0000', '\t', '\r', '\u001b', '\u007f', '\u0085', '\u2028', '\u2029', '\u202e', '\u2066']) {
    assert.equal(parse(envelope('body', current.map(line => line.replace('example-session-id', 'example' + char + '-id')))), null)
  }
})

test('invalid or ambiguous reply suffix causes entire-envelope fallback', () => {
  const json = JSON.stringify(reply)
  for (const ending of ['\n[回传参数]\n' + json, '\n\n[回传参数]', '\n\n[回传参数]\n{', '\n\n[回传参数]\n' + json + '\nprose', '\n\n[回传参数] trailing\n' + json, '\n\n [回传参数]\n' + json, suffix() + suffix(), '\n```\n\n[回传参数]\n' + json, '\n~~~text\n\n[回传参数]\n' + json + '\n~~~', '\n\n[回传参数]\n```json\n' + json + '\n```']) {
    assert.equal(parse(envelope('body' + ending)), null, ending)
  }
  for (const value of [null, [], 'text', 1, {}, { deliveryId: 'id' }, { responsePolicy: 'none' }, { deliveryId: '', responsePolicy: 'none' }, { deliveryId: '   ', responsePolicy: 'none' }, { deliveryId: 1, responsePolicy: 'none' }, { deliveryId: 'id\u0000', responsePolicy: 'none' }, { deliveryId: 'id', responsePolicy: 'later' }]) {
    assert.equal(parse(envelope('body' + suffix(value))), null)
  }
})

test('duplicate JSON keys including escaped names and nested objects fail closed', () => {
  for (const json of ['{"deliveryId":"id","deliveryId":"id","responsePolicy":"none"}', '{"deliveryId":"id","responsePolicy":"none","response\\u0050olicy":"required"}', '{"deliveryId":"id","responsePolicy":"none","extra":{"a":1,"a":2}}']) {
    assert.equal(parse(envelope('body\n\n[回传参数]\n' + json)), null)
  }
  const value = { deliveryId: 'id', responsePolicy: 'none', nested: [{ a: 1 }, { a: 2 }], text: '"key":{}[]' }
  assert.deepEqual(parse(envelope('body' + suffix(value))).replyParameters, value)
})

test('optional header delivery ID must agree with suffix and cannot be duplicated', () => {
  const header = [...current, '投递 ID：example-delivery-id']
  assert.equal(parse(envelope('body', header)).deliveryId, 'example-delivery-id')
  assert.equal(parse(envelope('body' + suffix(), header)).deliveryId, reply.deliveryId)
  assert.equal(parse(envelope('body' + suffix({ ...reply, deliveryId: 'other-id' }), header)), null)
  assert.equal(parse(envelope('body', [...header, '投递 ID：example-delivery-id'])), null)
})

test('parsed values are inert independent data; unknown JSON keys remain intact', () => {
  const raw = envelope('body\n\n[回传参数]\n{"deliveryId":"id","responsePolicy":"none","__proto__":{"example":true},"request":{"action":"send"}}')
  const parsed = parse(raw)
  assert.equal(Object.hasOwn(parsed.replyParameters, '__proto__'), true)
  assert.equal(Object.getPrototypeOf(parsed.replyParameters), Object.prototype)
  parsed.sender.sessionId = 'changed'
  parsed.replyParameters.request.action = 'changed'
  assert.equal(parse(raw).sender.sessionId, 'example-session-id')
  assert.equal(parse(raw).replyParameters.request.action, 'send')
  assert.equal(parsed.raw, raw)
})
