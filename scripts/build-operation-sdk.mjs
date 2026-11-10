/** Verify or rebuild the pinned, shared Rabi operation implementation. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendor = path.join(root, 'vendor/rabi-operation-sdk')
const manifest = JSON.parse(await fs.readFile(path.join(vendor, 'provenance.json'), 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const args = process.argv.slice(2)
let sourceRoot, check = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--check' && !check) check = true
  else if (args[i] === '--source-root' && !sourceRoot && args[i + 1] && !args[i + 1].startsWith('--')) sourceRoot = path.resolve(args[++i])
  else throw new Error('Use --check and/or --source-root <reviewed-rabi-checkout>.')
}
if (!sourceRoot && !check) throw new Error('Provide --source-root to rebuild, or --check to verify the committed bundle and notices.')
const artifact = path.join(root, manifest.artifact.path)
const license = await fs.readFile(path.join(vendor, manifest.licenseFile.path))
if (hash(license) !== manifest.licenseFile.sha256) throw new Error('The Rabi source license differs from its recorded hash.')
for (const entry of manifest.licenses) {
  if (!entry.file || entry.noticeFileMissing) throw new Error('A bundled dependency has no recorded license notice.')
  if (hash(await fs.readFile(path.join(vendor, entry.file))) !== entry.sha256) throw new Error('A bundled dependency notice differs: ' + entry.file)
}
if (sourceRoot) {
  const git = (...values) => execFileSync('git', ['-C', sourceRoot, ...values], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  if (git('rev-parse', manifest.commit + '^{commit}').toString().trim() !== manifest.commit) throw new Error('The pinned upstream commit is unavailable.')
  for (const entry of manifest.files) {
    const bytes = entry.virtual ? Buffer.from(manifest.entry) : await fs.readFile(path.join(sourceRoot, entry.path))
    if (!entry.virtual && !entry.path.startsWith('node_modules/')) {
      const source = git('show', manifest.commit + ':' + entry.path)
      if (source.length !== entry.gitBytes || hash(source) !== entry.gitSha256) throw new Error('The recorded upstream Git blob differs: ' + entry.path)
      const exactAuthorInput = bytes.length === entry.bytes && hash(bytes) === entry.sha256
      const knownCheckoutEol = entry.gitMatch === 'CRLF-to-LF' && bytes.toString('utf8').replace(/\r\n/g, '\n') === source.toString('utf8')
      if (!exactAuthorInput && !knownCheckoutEol || exactAuthorInput && entry.gitMatch === 'exact' && !bytes.equals(source)) {
        throw new Error('A selected source differs from the recorded Git content: ' + entry.path)
      }
    } else if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error('A selected dependency input differs: ' + entry.path)
  }
  const require = createRequire(import.meta.url)
  const { build, version } = require('esbuild')
  if (version !== manifest.esbuildVersion) throw new Error('Rebuild with the declared esbuild version ' + manifest.esbuildVersion + '.')
  const result = await build({ absWorkingDir: sourceRoot,
    stdin: { contents: manifest.entry, resolveDir: sourceRoot, sourcefile: 'rabi-operation-sdk-entry.mjs', loader: 'js' },
    outfile: artifact, bundle: true, format: 'esm', platform: 'node', target: 'node22', metafile: true,
    sourcemap: false, legalComments: 'inline', write: false,
    banner: { js: `/* Generated from RabiRoute ${manifest.commit}. MIT (c) 2026 vb2250158. See RabiRoute-LICENSE.txt and third-party-notices. */\nimport { createRequire as __rabiCreateRequire } from 'node:module';\nconst require = __rabiCreateRequire(import.meta.url);` } })
  const inputs = Object.keys(result.metafile.inputs).map(value => value.replaceAll('\\', '/')).sort()
  if (JSON.stringify(inputs) !== JSON.stringify(manifest.files.map(value => value.path).sort())) throw new Error('The selected build dependency set changed.')
  const bytes = result.outputFiles[0].contents
  if (bytes.length !== manifest.artifact.bytes || hash(bytes) !== manifest.artifact.sha256) throw new Error('The rebuilt artifact differs from its reviewed hash.')
  if (!check) await fs.writeFile(artifact, bytes)
}
const current = await fs.readFile(artifact)
if (current.length !== manifest.artifact.bytes || hash(current) !== manifest.artifact.sha256) throw new Error('The committed shared SDK differs from its reviewed artifact.')
console.log(JSON.stringify({ verified: true, rebuilt: Boolean(sourceRoot), written: Boolean(sourceRoot && !check),
  upstreamCommit: manifest.commit, artifactSha256: manifest.artifact.sha256, licenseNotices: manifest.licenses.length }))
