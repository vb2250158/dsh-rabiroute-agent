/** Pure historical Rabi-envelope projection; no runtime or UI registration. */
const fields = new Map([
  ['类型', 'type'], ['消息源类型', 'type'],
  ['处理端', 'agentAdapter'], ['Agent 端', 'agentAdapter'],
  ['角色', 'agentType'], ['会话', 'sessionName'], ['会话名称', 'sessionName'],
  ['会话 ID', 'sessionId'], ['工作目录', 'workspace'],
  ['投递时间', 'sentAt'], ['消息包发送时间', 'sentAt'], ['投递 ID', 'deliveryId'],
  ['计划名称', 'planName'], ['计划 ID', 'planId'],
  ['事件类型', 'eventType'], ['事件名称', 'eventName'], ['事件 ID', 'eventId'],
  ['触发方类型', 'actorType'], ['触发方名称', 'actorName'], ['触发方 ID', 'actorId'],
  ['消息路线', 'routeName'], ['消息路线 ID', 'routeId'],
  ['消息端', 'messageAdapter'],
  ['会话类型', 'conversationType'], ['发送者名称', 'senderName'], ['发送者 ID', 'senderId'],
  ['消息 ID', 'messageId'], ['消息组 ID', 'messageGroupId'],
])
// The source kinds the producer declares. `agent` keeps the historical `Agent`
// spelling, and is the only kind that is case-sensitive: a lowercase `agent` is
// not a value any producer writes, so it stays on the conservative fallback.
// `plan` and `system` never carried a session identity of their own, so their
// required fields are declared per kind.
const sourceKinds = new Map([
  ['Agent', { kind: 'agent', required: ['agentAdapter', 'sessionName', 'sessionId', 'sentAt'] }],
  ['计划', { kind: 'plan', required: ['planName', 'planId', 'sentAt'] }],
  ['系统', { kind: 'system', required: ['eventType', 'eventName', 'eventId', 'sentAt'] }],
])
const unsafeMetadata = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u
const trimSpaces = value => value.replace(/^ +| +$/g, '')
const nonemptyMetadata = value => typeof value === 'string' && Boolean(value.trim()) && !unsafeMetadata.test(value)

// JSON.parse accepts duplicate keys. Reject them at every object depth rather than
// concealing conflicting display data behind JSON's last-key-wins behavior.
function hasDuplicateKeys(json) {
  const stack = []
  const tokens = json.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/gs) || []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '{') stack.push(new Set())
    else if (token === '[') stack.push(null)
    else if (token === '}' || token === ']') stack.pop()
    else if (token.startsWith('"') && tokens[i + 1] === ':' && stack.at(-1)) {
      const key = JSON.parse(token)
      if (stack.at(-1).has(key)) return true
      stack.at(-1).add(key)
    }
  }
  return false
}

function parseReplySuffix(body) {
  const markers = [...body.matchAll(/^[ \t]*\[回传参数\]/gm)]
  if (!markers.length) return { body, replyParameters: null }
  if (markers.length !== 1) return null
  const marker = markers[0]
  const start = marker.index
  // Only the exact standalone marker with the protocol's blank-line delimiter
  // can be removed. An apparent but malformed control block fails the envelope.
  if (!body.startsWith('[回传参数]', start)) return null
  const prefix = body.slice(0, start)
  // Fence-aware Markdown rendering is outside this parser. Do not guess whether
  // a reply marker following a fence belongs to literal code or a control block.
  if (/^ {0,3}(?:`{3,}|~{3,})/m.test(prefix)) return null
  const separator = /(?:\r?\n){2}$/.exec(prefix)
  const suffix = body.slice(start)
  const opening = /^\[回传参数\]\r?\n/.exec(suffix)
  if (!separator || !opening) return null
  const json = suffix.slice(opening[0].length)
  let replyParameters
  try {
    replyParameters = JSON.parse(json)
  } catch {
    // Malformed terminal JSON leaves the entire envelope visible.
    return null
  }
  if (!replyParameters || typeof replyParameters !== 'object' || Array.isArray(replyParameters)
    || !nonemptyMetadata(replyParameters.deliveryId)
    || !['none', 'required'].includes(replyParameters.responsePolicy)
    || hasDuplicateKeys(json)) return null
  return { body: prefix.slice(0, separator.index), replyParameters }
}

/**
 * Project an anchored, unambiguous Rabi envelope for display.
 * Accept LF/CRLF, ASCII/fullwidth colons and the current first-line pipe;
 * aliases map to the same field and duplicates (even equal ones) fail closed.
 * Header markers are exact lines, separated from content by exactly one blank
 * line. Remove only that header, the content-marker newline, and, when valid,
 * the terminal reply block plus its two preceding newlines. Never trim body.
 * Additional context/control blocks remain body; malformed reply blocks return
 * null. Raw, sender fields, time and reply JSON are untrusted display data, not
 * authentication, navigation URLs, or instructions to execute. Consumers must
 * display raw unchanged on null and resolve full sender IDs via approved APIs.
 *
 * Three source kinds are projected. An `agent` envelope names the sending
 * session, so it can be located. A `plan` envelope names a plan, and a `system`
 * envelope names an event; neither carries a session identity of its own, so
 * `sender` stays null for them and the row must not offer navigation. An
 * unknown or misspelled kind still fails closed to the raw fallback.
 * @param {unknown} raw Historical message text; non-strings return null.
 * @returns {{raw: string, body: string, sourceType: string, plan?: object, event?: object, sender: object|null, sentAt: string, deliveryId?: string, replyParameters: object|null}|null} Display projection or conservative fallback.
 */
export function parseRabiMessageEnvelope(raw) {
  if (typeof raw !== 'string' || !/^\[消息源\]\r?\n/.test(raw)) return null
  const opening = /^\[消息源\]\r?\n/.exec(raw)[0]
  const headerEnd = /\r?\n\r?\n\[消息内容\](?:\r?\n|$)/.exec(raw.slice(opening.length))
  if (!headerEnd) return null
  const header = raw.slice(opening.length, opening.length + headerEnd.index)
  const values = new Map()
  const lines = header.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const parts = index === 0 && /^类型[：:]/.test(line) ? line.split(/[｜|]/) : [line]
    if (parts.length > 2) return null
    for (const part of parts) {
      const match = /^ *([^：:]+)[：:](.*)$/.exec(part)
      if (!match) return null
      const key = fields.get(trimSpaces(match[1]))
      const value = trimSpaces(match[2])
      if (!key || values.has(key) || !nonemptyMetadata(value)) return null
      values.set(key, value)
    }
  }
  const declared = sourceKinds.get(values.get('type'))
  if (!declared || !declared.required.every(key => values.has(key))) return null
  // Each kind owns a disjoint field set. A header mixing them (say a plan name
  // on a system envelope) is not a shape any producer writes, so it fails
  // closed rather than letting the renderer pick a label from ambiguous data.
  // `plan` additionally permits the source agent identity, because the producer
  // appends it to a plan envelope when one exists.
  const agentFields = ['agentAdapter', 'agentType', 'sessionName', 'sessionId', 'workspace']
  const allowed = declared.kind === 'agent' ? [...agentFields, 'sentAt', 'deliveryId']
    : declared.kind === 'plan' ? ['planName', 'planId', ...agentFields, 'sentAt', 'deliveryId']
      : ['eventType', 'eventName', 'eventId', 'actorType', 'actorName', 'actorId', 'routeName', 'routeId', 'sentAt', 'deliveryId']
  if ([...values.keys()].some(key => key !== 'type' && !allowed.includes(key))) return null
  // The producer writes no such thing as half an agent identity: `agentAdapter`
  // without a session (or the reverse) is a malformed record, not a partial one.
  // `agentType`/`workspace` stay independent optionals on every kind.
  const hasAnyIdentity = agentFields.some(key => values.has(key))
  if (hasAnyIdentity && !['agentAdapter', 'sessionName', 'sessionId'].every(key => values.has(key))) return null
  const content = raw.slice(opening.length + headerEnd.index + headerEnd[0].length)
  const parsed = parseReplySuffix(content)
  if (!parsed) return null
  const deliveryId = values.get('deliveryId')
  if (deliveryId && parsed.replyParameters && deliveryId !== parsed.replyParameters.deliveryId) return null
  const sentAt = values.get('sentAt')
  const identity = () => {
    const agent = { type: 'agent', agentAdapter: values.get('agentAdapter'), sessionName: values.get('sessionName'), sessionId: values.get('sessionId') }
    for (const key of ['agentType', 'workspace']) if (values.has(key)) agent[key] = values.get(key)
    return agent
  }
  const shared = { raw, ...parsed, sourceType: declared.kind, sentAt, ...(deliveryId ? { deliveryId } : {}) }
  if (declared.kind === 'agent') return { ...shared, sender: identity() }
  if (declared.kind === 'plan') {
    const plan = { planName: values.get('planName'), planId: values.get('planId') }
    if (hasAnyIdentity) plan.sourceAgent = identity()
    return { ...shared, plan, sender: null }
  }
  const event = { eventType: values.get('eventType'), eventName: values.get('eventName'), eventId: values.get('eventId') }
  for (const key of ['actorType', 'actorName', 'actorId', 'routeName', 'routeId']) if (values.has(key)) event[key] = values.get(key)
  return { ...shared, event, sender: null }
}
