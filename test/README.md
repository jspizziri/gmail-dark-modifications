# Test tooling

Tools for working on the stylesheet against a real Gmail DOM without a live
mailbox.

Captures live in `test/captures/` — a browser-saved Gmail page plus the
`_files/` directory saved alongside it. Both have to stay together, because a
saved page resolves its assets relative to itself; that is also why generated
previews are written into that directory rather than the repo root.

```
test/captures/
  gmail.html            gmail_files/
  gmail_replies.html    gmail_replies_files/
```

Captures are **not** in the repo (they contain real mail) — `test/captures/` is
gitignored wholesale. Save your own with ⌘S → "Web Page, Complete" and move both
the file and its folder in.

Keep one capture per UI state and pick between them with `CAPTURE`:

```sh
node test/harness.mjs x dist/gmail-dark.css                          # gmail.html
CAPTURE=gmail_replies.html node test/harness.mjs x dist/gmail-dark.css
```

A capture only shows the state it was saved in. Focused fields, expanded
recipient chips and open menus all need their own capture — the harness strips
the JS that would produce them.

Nothing here is part of the build. `npm run build` and `npm run release` do not
touch it.

## Day to day

```sh
npm run preview          # then open http://127.0.0.1:8000
```

Every capture in the repo root is served; switch between them with the picker in
the bottom-right corner, or go straight to one with `?capture=<name>`:

```
http://127.0.0.1:8000/?capture=gmail_replies.html
```

`CAPTURE=<name> npm run preview` sets which one opens by default. Captures are
discovered automatically — drop a new saved page into `test/captures/` and
restart.

One page that stays current. Edit any `src/*.less`, save, and the tab restyles
itself — the theme is attached as a `<link>` and only the stylesheet is
refetched. A build error leaves the last good CSS in place and prints the
failing file and line.

Served over HTTP rather than `file://` so the page can poll for changes. It is
serving your mail capture, so it binds to `127.0.0.1` only.

## Screenshots and measurement

```sh
node test/harness.mjs <variant> <css|--none>     # -> test/captures/preview-<variant>.html
                                                 #    + test/out/<variant>.png
SCROLL_TO=".Am.aO9" node test/harness.mjs reply dist/gmail-dark.css
WINDOW=1680,1600 node test/harness.mjs tall dist/gmail-dark.css
```

```sh
python3 test/image.py sample <png> <x,y> [x,y ...]   # colours at points
python3 test/image.py diff   <a.png> <b.png>         # what changed, where, by how much
python3 test/image.py scan   <png> [threshold] [x0 y0 x1 y1]
python3 test/image.py crop   <in> <out> x0 y0 x1 y1 [scale]
```

`scan` is the quickest way to find an unthemed element: an untouched Gmail
surface is almost always near-white, so a blob in the output is a bug with
coordinates attached.

Use the harness for before/after proof; use the live preview for eyeballing.
Every generated preview carries a build stamp — check it before trusting one:

```sh
grep -o "<!-- built [^>]*-->" test/captures/preview-reply.html
```

## Finding out why something looks wrong

```sh
node test/probe.mjs chain  <css> '<selector>'                 # ancestor chain
node test/probe.mjs region <css> x0 y0 x1 y1 [minArea]        # elements in a rectangle
node test/probe.mjs rules  <css> '<selector>' [property]      # which rule wins
```

`rules` is the one for "my rule is correct but nothing changed" — it found both
root causes in this stylesheet.

`region` honours `SCROLL_TO`, and **it must match the harness run you are
comparing against**, or its coordinates describe a different scroll position
than the screenshot and you will chase the wrong element.

All three descend into shadow roots and tag those rows `(shadow)`. Page CSS
cannot style shadow content at all, so a widget in one is not a gap in the
stylesheet — it is out of reach.

## Things about the capture that will mislead you

Each of these silently produces a wrong answer rather than an error. They are
handled in `capture.mjs`; the notes are here so nobody undoes them.

1. **Gmail's own scripts must be stripped.** They run on load, fail to reach the
   account, and replace the entire captured DOM with the "Temporary Error" page
   before anything paints. Opening a capture directly shows only that page.
   Disabling JS with `--blink-settings=scriptEnabled=false` is not a substitute:
   headless Chrome then exits without writing a screenshot at all.

2. **A saved page contains the theme that was installed when it was saved.**
   Stylus had already injected it, so the capture carries a
   `<style class="stylus">` with the *old* stylesheet baked in. Left alone,
   every render is the new theme layered on the old one and any rule that merely
   ties on specificity appears to do nothing.

3. **Gmail keeps `<style>` blocks inside `<body>`.** A stylesheet injected into
   `<head>` loses every specificity tie. Stylus appends its `<style>` last, so
   the tools inject before `</body>` to match.

4. **The inline reply is below Gmail's internal scroll fold.** It is laid out but
   clipped at scroll 0, so screenshots need `SCROLL_TO`. The live preview does
   not — just scroll the page.

5. **Chrome ignores `@-moz-document`.** The tools unwrap it and keep only the
   blocks targeting `mail.google.com`.
