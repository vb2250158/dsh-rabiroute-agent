import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
const root = new URL('../', import.meta.url)
test('packaging keeps compiled entry and bilingual guides without obsolete modules', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-chat'))
  const bundle = await readFile(new URL('lib/client.js', root), 'utf8')
  assert.match(bundle, /window\.__ModuleLoader__\.load/)
  assert.match(bundle, /id: 'dsh-rabiroute-agent'/)
  assert.doesNotMatch(bundle, /^import /m)
  let entry
  runInNewContext(bundle, { window: { __ModuleLoader__: { load: value => { entry = value } } } })
  assert.equal(entry.id, pkg.name)
  const client = entry.factory(name => {
    if (name === 'react') return { memo: component => component, createElement: () => null }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error('Unexpected browser dependency: ' + name)
  })
  assert.equal(typeof client.apply, 'function')
  assert.ok(client.inject.includes('slots'))
  assert.ok(client.inject.includes('sessions'))
  for (const name of ['README.md', 'README_en.md', 'CHANGELOG.md', 'CHANGELOG_en.md']) {
    assert.ok(pkg.files.includes(name))
    const content = await readFile(new URL(name, root), 'utf8')
    assert.ok(content.includes(pkg.version), 'documentation must identify the current release')
    assert.match(content, /English/)
  }
  for (const dir of ['src', 'lib']) {
    const entries = await readdir(new URL(dir + '/', root))
    for (const name of ['connection.js', 'index.js', 'client.js']) assert.ok(entries.includes(name))
    assert.ok(!entries.includes('invariant.js'))
    for (const name of ['index.js', 'connection.js']) {
      const content = await readFile(new URL(dir + '/' + name, root), 'utf8')
      assert.doesNotMatch(content, /8790|C:\\Users\\|C:\\Data\\/)
    }
  }
})
