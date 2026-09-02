#!/usr/bin/env node
// Builds both distributable files from source.less.
//
//   source.less  ──┬── lessc ──────────────────► dist/gmail-dark.css            (Mozilla format)
//                  └── comment strip-block ────► dist/gmail-dark.less.user.css  (Stylus usercss)
//
// Never edit the two outputs by hand; they are overwritten on every build.

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import less from 'less'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'source.less')
const OUT_USERCSS = join(ROOT, 'dist', 'gmail-dark.less.user.css')
const OUT_CSS = join(ROOT, 'dist', 'gmail-dark.css')

// Marks the fallback variable block. It stays live in source.less so lessc can
// compile standalone, and is commented out in the usercss so Stylus's @var
// declarations supply the values instead.
const STRIP_START = '//<<<usercss-strip'
const STRIP_END = '//>>>usercss-strip'

const checkOnly = process.argv.includes('--check')

function toUserCss(source) {
  const lines = source.split('\n')
  const start = lines.findIndex((l) => l.trim() === STRIP_START)
  const end = lines.findIndex((l) => l.trim() === STRIP_END)

  if (start === -1 || end === -1) {
    throw new Error(`source.less is missing the ${STRIP_START} / ${STRIP_END} markers`)
  }
  if (end < start) {
    throw new Error(`${STRIP_END} appears before ${STRIP_START} in source.less`)
  }

  lines[start] = '/*'
  lines[end] = '*/'
  return lines.join('\n')
}

async function toCss(source) {
  const { css } = await less.render(source, { filename: SOURCE, math: 'always' })
  return css
}

function readVersion(source) {
  const match = source.match(/^@version\s+(\S+)\s*$/m)
  if (!match) throw new Error('no @version found in the source.less metadata block')
  return match[1]
}

const source = await readFile(SOURCE, 'utf8')
const version = readVersion(source)

const outputs = [
  [OUT_USERCSS, toUserCss(source)],
  [OUT_CSS, await toCss(source)],
]

await mkdir(join(ROOT, 'dist'), { recursive: true })

let stale = 0
for (const [path, next] of outputs) {
  const name = path.slice(ROOT.length + 1)
  const current = await readFile(path, 'utf8').catch(() => null)

  if (current === next) {
    console.log(`  ok       ${name}`)
    continue
  }

  stale++
  if (checkOnly) {
    console.log(`  STALE    ${name}`)
  } else {
    await writeFile(path, next)
    console.log(`  written  ${name}`)
  }
}

if (checkOnly && stale > 0) {
  console.error(`\n${stale} file(s) out of date — run \`npm run build\` and commit the result.`)
  process.exit(1)
}

console.log(`\nv${version} — built from source.less`)
