// Run plugin regressions against the current built source Host's public peers.
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.DSH_SOURCE_ROOT
const peers = new Map([
  ['@deepseek-ai/schemastery', 'vendor/schemastery/package.json'],
  ['@deepseek-ai/dsh-tools', 'packages/core/tools/package.json'],
])
registerHooks({
  resolve(specifier, context, nextResolve) {
    const peer = root && peers.get(specifier)
    return nextResolve(specifier, peer ? { ...context, parentURL: pathToFileURL(resolve(root, peer)).href } : context)
  },
})
