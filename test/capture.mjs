// Shared handling for the local Gmail DOM capture (gmail.html, gitignored).
//
// A browser-saved Gmail page needs three things done to it before it is usable
// as a test fixture. Each of them silently produces a wrong answer if skipped:
//
//   1. Gmail's own scripts still run on load, fail to reach the account, and
//      replace the whole captured DOM with the "Temporary Error" page before
//      anything paints. (Disabling JS via --blink-settings=scriptEnabled=false
//      instead makes headless Chrome exit without writing a screenshot at all.)
//   2. Stylus had already injected the installed theme when the page was saved,
//      so the capture carries <style class="stylus"> with the *old* stylesheet
//      baked in. Left alone, every test renders the new theme layered on the old
//      one, and any rule that merely ties on specificity appears to do nothing.
//   3. Gmail keeps <style> blocks inside <body>, so a stylesheet injected into
//      <head> loses every specificity tie. Stylus appends its <style> last.

import { readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Captures and the pages generated from them live together, because a saved
// page resolves its assets relative to itself ("./gmail_files/…"). Anything
// written for the browser to open has to sit in here beside them.
export const CAPTURES = join(ROOT, 'test', 'captures')
export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Which saved page to work against. Several can coexist (one per UI state);
// CAPTURE picks between them, e.g. CAPTURE=gmail_replies.html. Each needs its
// sibling <name>_files/ directory, which is why previews live in the repo root.
export const CAPTURE = process.env.CAPTURE ?? 'gmail.html'

// Every saved page in the repo root, identified by having the sibling _files/
// directory a browser writes alongside it. One capture per UI state: a saved
// page only ever shows the state it was saved in.
export async function listCaptures() {
  const entries = await readdir(CAPTURES, { withFileTypes: true }).catch(() => [])
  const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name))
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => e.name)
    .filter((name) => dirs.has(name.replace(/\.html$/, '_files')))
    .sort()
}

// Reads a capture with the scripts and the previously-installed theme removed.
export async function loadCapture(name = CAPTURE) {
  const html = await readFile(join(CAPTURES, name), 'utf8')

  const scripts = (html.match(/<script\b/gi) || []).length
  let out = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')

  let stylus = 0
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (tag) => {
    // Match how it was saved (class="stylus") and also by content, so a capture
    // taken with a differently-tagged injector is still caught.
    if (/<style[^>]*\bclass\s*=\s*["'][^"']*\bstylus\b/i.test(tag) || tag.includes('invert(82.7451%)')) {
      stylus++
      return ''
    }
    return tag
  })

  if (!out.includes('</body>')) throw new Error('no </body> in the capture')
  return { html: out, scripts, stylus }
}

// Injects a stylesheet where Stylus would put it: last, after Gmail's own.
export function injectLast(html, ...blocks) {
  return html.replace('</body>', `${blocks.filter(Boolean).join('\n')}\n</body>`)
}

// The stylesheet is Mozilla-format; Chrome ignores @-moz-document, so unwrap it
// and keep only the blocks that target Gmail (the panel blocks are other origins).
export function unwrapMozDocument(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const at = source.indexOf('@-moz-document', i)
    if (at === -1) { out += source.slice(i); break }
    out += source.slice(i, at)
    const open = source.indexOf('{', at)
    const cond = source.slice(at, open)
    let depth = 1
    let j = open + 1
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth++
      else if (source[j] === '}') depth--
      j++
    }
    if (cond.includes('mail.google.com')) out += source.slice(open + 1, j - 1)
    i = j
  }
  return out
}

// Runs headless Chrome over a local file. `args` adds --screenshot or --dump-dom.
export function chrome(pagePath, args, capture = false) {
  return execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars',
    '--force-color-profile=srgb', `--window-size=${process.env.WINDOW ?? '1680,1050'}`,
    ...args, `file://${pagePath}`,
  ], capture
    ? { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] }
    : { stdio: ['ignore', 'ignore', 'ignore'] })
}

// Same, but for one-shot probes: the page has to sit beside the capture's
// _files/ directory for its relative asset paths to resolve, and each copy is
// ~6.5MB, so it is removed again as soon as Chrome exits.
export async function runPage(name, html, args) {
  const pagePath = join(CAPTURES, `.harness-${name}.html`)
  await writeFile(pagePath, html)
  try {
    return chrome(pagePath, args, true)
  } finally {
    await rm(pagePath, { force: true })
  }
}
