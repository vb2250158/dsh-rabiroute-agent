import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
test('packaging keeps compiled entry and bilingual guides without obsolete modules', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(pkg.main, 'lib/index.js')
  for (const name of ['README.md', 'README_en.md', 'CHANGELOG.md', 'CHANGELOG_en.md']) {
    assert.ok(pkg.files.includes(name))
    const content = await readFile(new URL(name, root), 'utf8')
    assert.match(content, /Unreleased/)
    assert.match(content, /English/)
  }
  for (const dir of ['src', 'lib']) {
    assert.deepEqual((await readdir(new URL(dir + '/', root))).sort(), ['connection.js', 'index.js'])
    for (const name of ['index.js', 'connection.js']) {
      const content = await readFile(new URL(dir + '/' + name, root), 'utf8')
      assert.doesNotMatch(content, /8790|C:\\Users\\|C:\\Data\\/)
    }
  }
})
