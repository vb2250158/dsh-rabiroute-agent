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
  assert.deepEqual(result.sender, { type: 'agent', agentAdapter: 'dsh', agentType: 'example-role', sessionName: 'example-session', sessionId: 'example-session-id', workspace: '/synthetic/workspace' })
  assert.equal(result.sentAt, '2000-01-02 03:04:05')
  assert.deepEqual(result.replyParameters, reply)
  assert.deepEqual(Object.keys(result).sort(), ['body', 'raw', 'replyParameters', 'sender', 'sentAt'])
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

test('other message source types always fall back to raw rendering', () => {
  for (const type of ['计划', '消息端', '系统', 'agent', 'Unknown']) {
    assert.equal(parse(envelope('body', legacy.map(line => line.replace('消息源类型：Agent', '消息源类型：' + type)))), null)
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
