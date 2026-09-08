#!/usr/bin/env node
// Builds both distributable files from src/index.less and the partials it imports.
//
//   src/index.less ─► bundle ──┬── lessc ──────────────────► dist/gmail-dark.css            (Mozilla format)
//                              └── comment strip-block ────► dist/gmail-dark.less.user.css  (Stylus usercss)
//
// The usercss output is the *source* itself with one block commented out, not
// compiled CSS, and Stylus compiles that single file in the browser with no
// filesystem to resolve `@import` against. So the build inlines the imports
// itself and hands the same flat bundle to both outputs.
//
// Never edit the two outputs by hand; they are overwritten on every build.

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import less from 'less'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const ENTRY = 'index.less'
const OUT_USERCSS = join(ROOT, 'dist', 'gmail-dark.less.user.css')
const OUT_CSS = join(ROOT, 'dist', 'gmail-dark.css')

// Marks the fallback variable block. It stays live in the source so lessc can
// compile standalone, and is commented out in the usercss so Stylus's @var
// declarations supply the values instead.
const STRIP_START = '//<<<usercss-strip'
const STRIP_END = '//>>>usercss-strip'

// Deliberately strict: a bare `@import "file.less";`, one per line. Import
// options like (reference) or (css) change what Less emits and inlining would
// silently ignore them, so they are rejected rather than half-supported.
const IMPORT = /^\s*@import\s+(\([^)]*\)\s*)?(['"])([^'"]+)\2\s*;/

const checkOnly = process.argv.includes('--check')

// Flattens the import tree into the single source both outputs are built from,
// recording where each run of lines came from so lessc errors — which are
// reported against the bundle — can be pointed back at the real file.
async function bundle() {
  const lines = []
  const map = []
  const imported = new Set()

  async function emit(name, stack) {
    if (stack.includes(name)) {
      throw new Error(`circular @import: ${[...stack, name].map((n) => `src/${n}`).join(' -> ')}`)
    }
    imported.add(name)

    const text = await readFile(join(SRC, name), 'utf8').catch(() => {
      throw new Error(`src/${stack.at(-1)} imports src/${name}, which does not exist`)
    })
    const source = text.replace(/\n$/, '').split('\n')

    // The first line after an import lands mid-array, so a new map entry is
    // needed there as well as at the start of the file.
    let mark = true

    for (const [i, line] of source.entries()) {
      const match = IMPORT.exec(line)
      if (match) {
        if (match[1]) {
          throw new Error(
            `src/${name}:${i + 1} — @import option ${match[1].trim()} is not supported; the build inlines imports`,
          )
        }
        await emit(match[3], [...stack, name])
        mark = true
        continue
      }
      if (mark) {
        map.push({ at: lines.length, file: name, line: i + 1 })
        mark = false
      }
      lines.push(line)
    }
  }

  await emit(ENTRY, [])

  const orphans = (await readdir(SRC))
    .filter((f) => f.endsWith('.less') && !imported.has(f))
    .map((f) => `src/${f}`)
  if (orphans.length) {
    throw new Error(`${orphans.join(', ')} is not reached from src/${ENTRY} — add an @import for it`)
  }

  return { source: lines.join('\n') + '\n', map }
}

// lessc counts lines in the flattened bundle; translate one back to its partial.
function locate(map, bundleLine) {
  if (!bundleLine) return null
  const entry = [...map].reverse().find((e) => e.at < bundleLine)
  return entry ? `src/${entry.file}:${entry.line + (bundleLine - 1 - entry.at)}` : null
}

function toUserCss(source) {
  const lines = source.split('\n')
  const start = lines.findIndex((l) => l.trim() === STRIP_START)
  const end = lines.findIndex((l) => l.trim() === STRIP_END)

  if (start === -1 || end === -1) {
    throw new Error(`src/variables.less is missing the ${STRIP_START} / ${STRIP_END} markers`)
  }
  if (end < start) {
    throw new Error(`${STRIP_END} appears before ${STRIP_START} in src/variables.less`)
  }

  lines[start] = '/*'
  lines[end] = '*/'
  return lines.join('\n')
}

async function toCss(source, map) {
  try {
    const { css } = await less.render(source, { filename: join(SRC, ENTRY), math: 'always' })
    return css
  } catch (err) {
    const where = locate(map, err.line)
    throw new Error(where ? `${where} — ${err.message}` : err.message)
  }
}

function readVersion(source) {
  const match = source.match(/^@version\s+(\S+)\s*$/m)
  if (!match) throw new Error('no @version found in the src/metadata.less header')
  return match[1]
}

let outputs, version
try {
  const { source, map } = await bundle()
  version = readVersion(source)
  outputs = [
    [OUT_USERCSS, toUserCss(source)],
    [OUT_CSS, await toCss(source, map)],
  ]
} catch (err) {
  console.error(`✗ ${err.message}`)
  process.exit(1)
}

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

console.log(`\nv${version} — built from src/${ENTRY}`)
