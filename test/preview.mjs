#!/usr/bin/env node
// Live preview: one page, always current.
//
//   npm run preview          then open http://127.0.0.1:8000
//
// Serves the local Gmail capture with the theme attached as a <link>, watches
// src/, rebuilds on every save, and reloads just the stylesheet in the browser.
// Editing a .less file and glancing at the tab is the whole loop — no
// regenerating, no stale snapshot to mistake for a live one.
//
// Served over HTTP rather than file:// so the page can poll for changes; the
// capture contains real mail, so it binds to 127.0.0.1 only.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, extname, normalize } from 'node:path'
import { ROOT, CAPTURES, CAPTURE, listCaptures, loadCapture, injectLast, unwrapMozDocument } from './capture.mjs'

const PORT = Number(process.env.PORT ?? 8000)
const CSS = join(ROOT, 'dist', 'gmail-dark.css')

// Bumped on every successful rebuild; the page polls it and re-fetches the CSS.
let version = Date.now()
let building = false
let lastError = null

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
}

const reloader = `<script>
(function () {
  var current = null;
  setInterval(async function () {
    try {
      var v = await (await fetch('/version', { cache: 'no-store' })).text();
      if (current === null) { current = v; return; }
      if (v !== current) {
        current = v;
        var link = document.getElementById('theme-under-test');
        link.href = '/theme.css?v=' + encodeURIComponent(v);
        var note = document.getElementById('reload-note');
        note.textContent = 'reloaded ' + new Date().toLocaleTimeString();
        note.style.opacity = '1';
        setTimeout(function () { note.style.opacity = '0' }, 1500);
      }
    } catch (e) {}
  }, 400);
})();
</script>
<div id="reload-note" style="position:fixed;right:12px;bottom:44px;z-index:2147483647;
  font:12px/1.4 system-ui,sans-serif;background:#222;color:#eee;padding:6px 10px;
  border-radius:6px;opacity:0;transition:opacity .2s;pointer-events:none"></div>`

// Lets you flip between captures without restarting the server. Each is a
// different UI state, so this is the difference between checking one screen and
// checking all of them.
function picker(captures, current) {
  if (captures.length < 2) return ''
  const options = captures.map((c) =>
    `<option value="${c}"${c === current ? ' selected' : ''}>${c}</option>`).join('')
  return `<div style="position:fixed;right:12px;bottom:12px;z-index:2147483647;
    font:12px/1.4 system-ui,sans-serif;background:#222;color:#eee;padding:5px 8px;
    border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.5)">
    <select style="background:#222;color:#eee;border:1px solid #555;border-radius:4px;
      padding:2px 4px;font:inherit"
      onchange="location.search='?capture='+encodeURIComponent(this.value)">${options}</select>
  </div>`
}

// Pages are built once each and cached; only the stylesheet is refetched.
const captures = await listCaptures()
if (!captures.length) {
  console.error(`\n  no capture found in ${CAPTURES}\n  save a Gmail page with \u2318S \u2192 "Web Page, Complete"\n`)
  process.exit(1)
}
const defaultCapture = captures.includes(CAPTURE) ? CAPTURE : captures[0]
const pages = new Map()

async function getPage(name) {
  if (!pages.has(name)) {
    const { html, scripts, stylus } = await loadCapture(name)
    console.log(`  loaded ${name} (${scripts} scripts, ${stylus} stylus sheet(s) stripped)`)
    pages.set(name, injectLast(
      html,
      `<link id="theme-under-test" rel="stylesheet" href="/theme.css">`,
      reloader,
      picker(captures, name),
    ))
  }
  return pages.get(name)
}

function rebuild(reason) {
  if (building) return
  building = true
  execFile('node', [join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT }, (err, stdout, stderr) => {
    building = false
    const out = `${stdout || ''}${stderr || ''}`.trim()
    if (err) {
      lastError = out || err.message
      console.log(`\n  ✗ ${reason} — build failed, serving last good CSS\n${lastError.replace(/^/gm, '    ')}`)
      return
    }
    lastError = null
    version = Date.now()
    console.log(`  rebuilt (${reason}) — browser will reload the stylesheet`)
  })
}

let timer = null
watch(join(ROOT, 'src'), { recursive: true }, (_e, file) => {
  if (!file || !file.endsWith('.less')) return
  clearTimeout(timer)
  timer = setTimeout(() => rebuild(`src/${file}`), 120)
})

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (url.pathname === '/version') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
    return res.end(String(version))
  }

  if (url.pathname === '/theme.css') {
    const css = await readFile(CSS, 'utf8').catch(() => '')
    res.writeHead(200, { 'content-type': TYPES['.css'], 'cache-control': 'no-store' })
    // Chrome ignores @-moz-document, so hand it the Gmail blocks unwrapped.
    return res.end(unwrapMozDocument(css))
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const want = url.searchParams.get('capture')
    const name = captures.includes(want) ? want : defaultCapture
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' })
    return res.end(await getPage(name))
  }

  // Everything else is a captured asset (gmail_files/…), served from the
  // captures directory and confined to it.
  const path = join(CAPTURES, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''))
  if (!path.startsWith(CAPTURES)) { res.writeHead(403); return res.end('forbidden') }

  const body = await readFile(path).catch(() => null)
  if (!body) { res.writeHead(404); return res.end('not found') }
  res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' })
  res.end(body)
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  live preview  http://127.0.0.1:${PORT}`)
  console.log(`  captures      ${captures.join(', ')}  (switch bottom-right, or ?capture=<name>)`)
  console.log(`  watching      src/*.less — save a file and the page restyles itself`)
  console.log(`  note          serves the local mail capture; bound to 127.0.0.1 only\n`)
})
