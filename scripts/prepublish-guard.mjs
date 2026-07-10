#!/usr/bin/env node
// prepublish guard — verify the tree is publishable WITHOUT building.
//
// `prepublishOnly` historically ran `pnpm build`, whose `prebuild` deletes dist/.
// Since the global `openwolf` CLI symlinks into dist/bin/openwolf.js, a failed
// build during publish would take the installed CLI down with it — and a publish
// at the wrong moment could ship a stale dist/. This script builds nothing; it
// refuses to publish unless dist/ is present, fresh, committed, and tagged.
//
// Bypass for emergencies only: npm publish --ignore-scripts (you own the risk).

import { execSync } from 'node:child_process'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (msg) => {
  console.error(`\n✗ prepublish guard: ${msg}\n`)
  console.error('  Nothing was published. Fix the above, or bypass with')
  console.error('  `npm publish --ignore-scripts` if you know dist/ is correct.\n')
  process.exit(1)
}
const ok = (msg) => console.log(`  ✓ ${msg}`)

console.log('\nprepublish guard — checking the tree is publishable (no build):')

// 1) Required build artifacts exist.
const required = [
  'dist/bin/openwolf.js',
  'dist/hooks',
  'dist/dashboard',
]
for (const rel of required) {
  if (!existsSync(join(root, rel))) {
    fail(`missing build artifact: ${rel}\n  Run \`pnpm build\` first, then publish.`)
  }
}
ok('dist/ present (bin, hooks, dashboard)')

// 2) No source file is newer than the compiled CLI — i.e. dist/ is not stale.
const binMtime = statSync(join(root, 'dist/bin/openwolf.js')).mtimeMs
const stale = []
const walk = (dir) => {
  for (const ent of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dashboard') continue // dashboard built by vite
    const rel = join(dir, ent.name)
    if (ent.isDirectory()) { walk(rel); continue }
    if (!/\.(ts|tsx)$/.test(ent.name)) continue
    if (statSync(join(root, rel)).mtimeMs > binMtime) stale.push(rel)
  }
}
walk('src')
if (stale.length) {
  fail(`dist/ is stale — these sources are newer than the compiled CLI:\n    ${stale.slice(0, 8).join('\n    ')}${stale.length > 8 ? `\n    …and ${stale.length - 8} more` : ''}\n  Run \`pnpm build\` and commit before publishing.`)
}
ok(`dist/ is fresh (no source newer than the compiled CLI)`)

// 3) Working tree is clean — publish exactly what is committed.
const git = (args) => execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim()
let dirty = ''
try { dirty = git('status --porcelain') } catch { fail('not a git repository (cannot verify commit state)') }
if (dirty) {
  fail(`working tree is dirty — commit or stash first:\n    ${dirty.split('\n').slice(0, 10).join('\n    ')}`)
}
ok('working tree clean')

// 4) package.json version has a matching tag on HEAD.
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const tag = `v${version}`
let tagCommit = ''
try { tagCommit = git(`rev-list -n1 ${tag}`) } catch { fail(`no git tag ${tag} — tag this release before publishing:\n    git tag -a ${tag} -F <changelog-section>`) }
const head = git('rev-parse HEAD')
if (tagCommit !== head) {
  fail(`tag ${tag} points at ${tagCommit.slice(0, 7)} but HEAD is ${head.slice(0, 7)} — retag or check out the tagged commit.`)
}
ok(`version ${version} matches tag ${tag} on HEAD`)

console.log('\n✓ publishable — proceeding.\n')
