import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { internals } from '../lib/index.js'

const local = { managerBaseUrl: 'http://127.0.0.1:12345', localAgentUnrestricted: true }
const core = process.env.DSH_TEST_SOURCE_ROOT
const validator = core ? await import(pathToFileURL(core + '/packages/core/tools/lib/index.js').href) : null
const context = () => ({ signal: new AbortController().signal })
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })

function checkOutput(tool, value) {
  assert.deepEqual(value, JSON.parse(JSON.stringify(value)), 'tool receipts must survive lossless JSON projection')
  for (const key of Object.keys(value)) assert.ok(Object.hasOwn(tool.output.schema.properties, key), 'undeclared output field: ' + key)
  for (const key of Object.keys(value.error ?? {})) assert.ok(Object.hasOwn(tool.output.schema.properties.error.properties, key), 'undeclared error field: ' + key)
  if (validator) {
    validator.assertSupportedJsonSchema(tool.output.schema)
    assert.deepEqual(validator.validateJsonSchemaValue(tool.output.schema, value), [])
  }
}

test('all local Rabi tools return lossless receipts with declared output fields', async () => {
  const tools = internals.toolDefinitions(local, { fetch: async () => response({ code: 0, data: {} }) })
  for (const tool of tools) {
    const args = tool.name === 'rabiroute_manager_api' ? { method: 'GET', path: '/api/personas' } : { requestJson: JSON.stringify({ action: 'list' }) }
    const result = await tool.execute(args, context())
    assert.equal(result.ok, true)
    assert.equal(result.localUnrestricted, true)
    assert.equal(Object.hasOwn(result, 'identity'), false)
    checkOutput(tool, result)
  }
})

test('local transport failures preserve read failure and uncertain write receipts without replay', async () => {
  for (const method of ['GET', 'POST']) {
    let requests = 0
    const tool = internals.toolDefinitions(local, { fetch: async () => { requests++; throw new Error('fixture connection interrupted') } }).at(-1)
    const result = await tool.execute({ method, path: '/api/sample' }, context())
    assert.equal(result.ok, false)
    assert.equal(result.uncertain, method === 'POST')
    assert.equal(requests, 1)
    assert.equal(Object.hasOwn(result, 'identity'), false)
    checkOutput(tool, result)
  }
})

test('Manager rejection codes and Hook diagnostics pass the tool output schema', async () => {
  for (const reject of [false, true]) {
    const tool = internals.toolDefinitions(local, { fetch: async () => response(reject ? { code: -1, error: 'FIXTURE_UNAVAILABLE', message: 'Fixture unavailable' } : { code: 0 }, reject ? 503 : 200) }).at(-1)
    const result = await tool.execute({ method: 'POST', path: '/api/codex-hook/context' }, context())
    assert.equal(result.ok, !reject)
    assert.equal(result.diagnostic.reason, reject ? 'manager_rejected' : 'completed')
    if (reject) assert.equal(result.error.code, 'FIXTURE_UNAVAILABLE')
    checkOutput(tool, result)
  }
})

test('local timeout returns its original uncertain receipt as valid JSON', async () => {
  let requests = 0
  const tool = internals.toolDefinitions({ ...local, requestTimeoutMs: 1000 }, { fetch: async (_url, { signal }) => {
    requests++
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } }).at(-1)
  const result = await tool.execute({ method: 'POST', path: '/api/codex-hook/context' }, context())
  assert.equal(result.uncertain, true)
  assert.equal(result.diagnostic.reason, 'timeout')
  assert.equal(requests, 1)
  checkOutput(tool, result)
})

test('verified connections retain their observed Manager identity', async () => {
  const identity = { applicationGenerationId: 'fixture-generation', managerInstanceId: 'fixture-instance' }
  const tool = internals.toolDefinitions({ managerBaseUrl: 'https://manager.example.invalid' }, { fetch: async url => response(url.endsWith('/meta')
    ? { ...identity, health: { live: true, requiredReady: true, state: 'healthy' } } : { code: 0 }) }).at(-1)
  const result = await tool.execute({ method: 'GET', path: '/api/personas' }, context())
  assert.equal(result.ok, true)
  assert.deepEqual(result.identity, identity)
  assert.equal(Object.hasOwn(result, 'localUnrestricted'), false)
  checkOutput(tool, result)
})

test('real DSH execution accepts local Rabi receipts and retains Manager failures', { skip: !core }, async () => {
  const { ToolExecutionPipeline } = await import(pathToFileURL(core + '/packages/core/tools/lib/pipeline.js').href)
  for (const rejected of [false, true]) {
    const tool = internals.toolDefinitions(local, { fetch: async () => response(rejected ? { code: -1, error: 'FIXTURE_REJECTED' } : { personas: [] }, rejected ? 403 : 200) }).at(-1)
    const ctx = { tools: { checkGuards: () => undefined }, waterfall: (...args) => args.at(-1)(), events: { dispatch: () => [] }, logger: { warn: assert.fail } }
    const pipeline = new ToolExecutionPipeline(ctx, { get: () => tool })
    const prepared = await pipeline.prepare({ name: tool.name, callId: 'fixture-call', arguments: { method: 'GET', path: '/api/personas' }, signal: new AbortController().signal })
    assert.equal(prepared.kind, 'dispatch')
    const result = await pipeline.complete(prepared.exec, await pipeline.dispatch(prepared.exec))
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.ok, !rejected)
    if (rejected) assert.equal(result.value.error.code, 'FIXTURE_REJECTED')
  }
})
