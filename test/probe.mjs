#!/usr/bin/env node
// Asks the rendered page questions that a screenshot cannot answer.
//
//   node test/probe.mjs chain  <css|--none> '<selector>'
//   node test/probe.mjs region <css|--none> <x0> <y0> <x1> <y1> [minArea]
//   node test/probe.mjs rules  <css|--none> '<selector>' [property]
//
//   chain    ancestor chain of an element, with the computed values that decide
//            how it looks — use it to find which container to scope a rule to.
//   region   every element occupying a rectangle of the viewport — use it when
//            you can see something in a screenshot but cannot name it.
//   rules    every rule that matches an element and sets a property, in sheet
//            order — the tool for "my rule is correct but nothing changed".
//
// CAPTURE picks the fixture, SCROLL_TO brings an element into view first. For
// `region`, SCROLL_TO must match the harness run you are comparing against, or
// the coordinates describe a different scroll position than the screenshot.

import { readFile } from 'node:fs/promises'
import { loadCapture, injectLast, unwrapMozDocument, runPage } from './capture.mjs'

const SEP = ' ;; '
const [mode, cssArg, ...rest] = process.argv.slice(2)

const USAGE = `usage:
  node test/probe.mjs chain  <css|--none> '<selector>'
  node test/probe.mjs region <css|--none> <x0> <y0> <x1> <y1> [minArea]
  node test/probe.mjs rules  <css|--none> '<selector>' [property]`

if (!['chain', 'region', 'rules'].includes(mode) || !cssArg) {
  console.error(USAGE)
  process.exit(1)
}

const { html } = await loadCapture()
const css = cssArg === '--none' ? '' : await readFile(cssArg, 'utf8')
const style = css ? `<style>\n${unwrapMozDocument(css)}\n</style>` : ''
const scrollTo = process.env.SCROLL_TO

// Shared by every mode: describe an element the way we always want to see it.
const helpers = `
  var SEP = ${JSON.stringify(SEP)};
  function label(el) {
    var name = el.tagName.toLowerCase() +
      (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
    return (el.getRootNode() instanceof ShadowRoot ? '(shadow) ' : '') + name;
  }
  function describe(el, width) {
    var cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return [
      label(el).slice(0, width).padEnd(width),
      String(cs.backgroundColor).padEnd(22),
      String(cs.color).padEnd(22),
      String(cs.borderRadius).slice(0, 12).padEnd(12),
      (cs.filter === 'none' ? '' : 'FILTERED').padEnd(9),
      Math.round(r.left) + ',' + Math.round(r.top) + ' ' +
        Math.round(r.width) + 'x' + Math.round(r.height),
    ].join(' ');
  }
  // Shadow roots are invisible to querySelectorAll and unstylable from page CSS,
  // so a widget hiding in one looks like it simply does not exist.
  function everything(root, acc) {
    for (var el of root.querySelectorAll('*')) {
      acc.push(el);
      if (el.shadowRoot) everything(el.shadowRoot, acc);
    }
    return acc;
  }
  function emit(rows) {
    var out = document.createElement('div');
    out.id = 'PROBE_OUT';
    out.textContent = rows.join(SEP);
    document.body.appendChild(out);
  }`

const bodies = {
  chain: (sel) => `
    var el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return emit(['NO ELEMENT MATCHES ' + ${JSON.stringify(sel)}]);
    var rows = [], depth = 0;
    for (var n = el; n && n !== document.documentElement; n = n.parentElement) {
      rows.unshift(describe(n, 44));
      if (++depth > 14) break;
    }
    emit(rows.map(function (r, i) { return '  '.repeat(i) + r }));`,

  region: ([x0, y0, x1, y1, minArea = '400']) => `
    var X0 = ${+x0}, Y0 = ${+y0}, X1 = ${+x1}, Y1 = ${+y1}, MIN = ${+minArea};
    var rows = [];
    for (var el of everything(document, [])) {
      var r = el.getBoundingClientRect();
      if (r.width * r.height < MIN) continue;
      if (r.right < X0 || r.left > X1 || r.bottom < Y0 || r.top > Y1) continue;
      rows.push(describe(el, 46));
    }
    emit(rows);`,

  rules: (sel, prop) => `
    var el = document.querySelector(${JSON.stringify(sel)});
    var prop = ${JSON.stringify(prop)};
    if (!el) return emit(['NO ELEMENT MATCHES ' + ${JSON.stringify(sel)}]);
    var rows = [], n = 0;
    for (var sheet of document.styleSheets) {
      n++;
      var rules; try { rules = sheet.cssRules } catch (e) { continue }
      for (var rule of rules) {
        if (!rule.selectorText || !rule.style) continue;
        var value = rule.style.getPropertyValue(prop) ||
                    rule.style.getPropertyValue(prop.replace(/-color$/, ''));
        if (!value) continue;
        for (var s of rule.selectorText.split(',')) {
          s = s.trim();
          try {
            if (el.matches(s)) {
              rows.push('sheet#' + n + '  ' + s + '  { ' + value +
                (rule.style.getPropertyPriority(prop) ? ' !important' : '') + ' }');
            }
          } catch (e) {}
        }
      }
    }
    rows.push('--- inline style attr: ' + (el.getAttribute('style') || '(none)'));
    rows.push('--- computed ' + prop + ': ' + getComputedStyle(el).getPropertyValue(prop));
    emit(rows);`,
}

const body =
  mode === 'chain' ? bodies.chain(rest[0])
  : mode === 'region' ? bodies.region(rest)
  : bodies.rules(rest[0], rest[1] ?? 'background-color')

if ((mode === 'chain' || mode === 'rules') && !rest[0]) { console.error(USAGE); process.exit(1) }
if (mode === 'region' && rest.length < 4) { console.error(USAGE); process.exit(1) }

const probe = `<script>
window.addEventListener('load', function () {
  ${scrollTo ? `var t = document.querySelector(${JSON.stringify(scrollTo)}); if (t) t.scrollIntoView({ block: 'center' });` : ''}
  ${helpers}
  (function () {${body}})();
});
</script>`

const dom = await runPage('probe', injectLast(html, style, probe), ['--dump-dom'])
const m = dom.match(/<div id="PROBE_OUT">([\s\S]*?)<\/div>/)
if (!m) { console.error('probe produced no output — did the script run?'); process.exit(1) }

const unescape = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&')

if (mode === 'rules') {
  console.log(`rules matching ${rest[0]} that set ${rest[1] ?? 'background-color'}, last one wins:\n`)
  for (const line of m[1].split(SEP)) console.log('  ' + unescape(line).trim())
} else {
  const w = mode === 'chain' ? 44 : 46
  console.log('element'.padEnd(w) + ' ' + 'background'.padEnd(22) + ' ' + 'color'.padEnd(22) +
              ' ' + 'radius'.padEnd(12) + ' ' + 'filter'.padEnd(9) + ' rect')
  console.log('-'.repeat(w + 72))
  for (const line of m[1].split(SEP)) console.log(unescape(line))
}
