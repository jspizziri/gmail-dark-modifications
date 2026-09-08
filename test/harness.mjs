#!/usr/bin/env node
// Renders the local Gmail DOM capture with a given stylesheet, so theme changes
// can be checked without a live mailbox.
//
//   node test/harness.mjs <variant> <css-file|--none>
//
// Writes preview-<variant>.html (open it in a browser) and test/out/<variant>.png.
// The preview must sit in the repo root — its asset paths point into gmail_files/.

import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, CAPTURES, loadCapture, injectLast, unwrapMozDocument, chrome } from './capture.mjs'

const [variant, cssArg] = process.argv.slice(2)
if (!variant || !cssArg) {
  console.error('usage: node test/harness.mjs <variant> <css-file|--none>')
  process.exit(1)
}

const { html, scripts, stylus } = await loadCapture()
const css = cssArg === '--none' ? '' : await readFile(cssArg, 'utf8')
const style = css ? `<style id="theme-under-test">\n${unwrapMozDocument(css)}\n</style>` : ''

// Gmail scrolls the message pane internally, so anything below its fold is
// laid out but clipped at scroll 0 and never reaches the screenshot. SCROLL_TO
// takes a selector to bring into view first.
const scrollTo = process.env.SCROLL_TO
const scroll = scrollTo ? `<script>
window.addEventListener('load', function () {
  var el = document.querySelector(${JSON.stringify(scrollTo)});
  if (el) el.scrollIntoView({ block: 'center' });
});
</script>` : ''

// Stamp the preview with what it was built from. Previews are big files that
// linger in the repo root, and a stale one looks exactly like a live one — the
// only way to tell is to read this back out.
const stamp = `<!-- built ${new Date().toISOString()} from ${cssArg} -->`

const pagePath = join(CAPTURES, `preview-${variant}.html`)
const shot = join(ROOT, 'test', 'out', `${variant}.png`)
await mkdir(join(ROOT, 'test', 'out'), { recursive: true })
await writeFile(pagePath, injectLast(html, style, scroll, stamp))

chrome(pagePath, [`--screenshot=${shot}`])

// Warn about every other preview left in the root that is now older than this
// one, so a stale file is never mistaken for the current render.
const stale = (await readdir(CAPTURES))
  .filter((f) => f.startsWith('preview-') && f.endsWith('.html') && f !== `preview-${variant}.html`)
  .filter((f) => statSync(join(CAPTURES, f)).mtimeMs < statSync(pagePath).mtimeMs)

console.log(`${variant.padEnd(10)} test/captures/preview-${variant}.html + test/out/${variant}.png`)
if (stale.length) {
  console.log(`${''.padEnd(10)} STALE, older than this build: ${stale.join(', ')}`)
}
console.log(`${''.padEnd(10)} stripped ${scripts} scripts, ${stylus} pre-installed stylus sheet(s); css: ${cssArg === '--none' ? 'none' : cssArg}`)
