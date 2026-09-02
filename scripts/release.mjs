#!/usr/bin/env node
// Cuts a release: bumps @version, rebuilds both dists, commits and tags.
//
//   npm run release -- patch      2.5.3 -> 2.5.4
//   npm run release -- minor      2.5.3 -> 2.6.0
//   npm run release -- major      2.5.3 -> 3.0.0
//   npm run release -- 3.1.4      explicit version
//
// Stops before pushing; the push command is printed for you to run.
//
// The version bump is the point of this script: Stylus compares @version to
// decide whether an update exists. Push changed CSS without bumping and every
// installed copy will keep reporting itself up to date.

import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'source.less')
const PKG = join(ROOT, 'package.json')

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1) }

const bump = process.argv[2]
if (!bump) fail('usage: npm run release -- <patch|minor|major|x.y.z>')

if (git('status', '--porcelain')) fail('working tree is dirty — commit or stash first')

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'master') fail(`on branch "${branch}", expected "master"`)

const source = await readFile(SOURCE, 'utf8')
const current = source.match(/^@version\s+(\S+)\s*$/m)?.[1]
if (!current) fail('no @version in source.less')

let next
if (/^\d+\.\d+\.\d+$/.test(bump)) {
  next = bump
} else {
  const [maj, min, pat] = current.split('.').map(Number)
  if ([maj, min, pat].some(Number.isNaN)) fail(`@version "${current}" is not semver`)
  next = { major: `${maj + 1}.0.0`, minor: `${maj}.${min + 1}.0`, patch: `${maj}.${min}.${pat + 1}` }[bump]
  if (!next) fail(`unknown bump "${bump}" — use patch, minor, major, or an explicit x.y.z`)
}

const tag = `v${next}`
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists`)

console.log(`${current} -> ${next}\n`)

await writeFile(SOURCE, source.replace(/^@version\s+\S+\s*$/m, `@version        ${next}`))

const pkg = JSON.parse(await readFile(PKG, 'utf8'))
pkg.version = next
await writeFile(PKG, JSON.stringify(pkg, null, 2) + '\n')

execFileSync('node', [join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'inherit' })

git('add', '-A')
git('commit', '-m', `release: ${tag}`)
git('tag', '-a', tag, '-m', tag)

console.log(`\n✓ committed and tagged ${tag}`)
console.log(`\nPush it (this is what makes the update visible to Stylus):`)
console.log(`    git push origin master --follow-tags`)
