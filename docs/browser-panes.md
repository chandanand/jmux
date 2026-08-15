# Browser Panes

A real browser, in a pane, beside the agent that's building the thing.

`Ctrl-Space b` splits the current pane and puts Chromium in it — a live page you can
click, scroll, fill in and open DevTools on, rendered into the terminal with the
same graphics protocol jmux uses for [inline images](issue-tracking.md#images-in-issue-previews).
Your agent can drive it too.

---

## Credit

**The browser is not jmux's work.** It is
[terminal-browser](https://github.com/zenbu-labs/terminal-browser), an
open-source project by [Zenbu Labs](https://github.com/zenbu-labs) released
under the MIT licence, and it is the thing that solved the hard problem: getting
Chromium to render into a terminal at all.

What jmux adds around it is plumbing — relaying its graphics past the
multiplexer, telling tmux the real pixel size of a cell so the pane is the size
it looks, giving each pane its own browser process, and exposing it to agents
through `jmux ctl browser`. Everything you actually look at in a browser pane
was drawn by terminal-browser.

jmux does not bundle or redistribute it. You install it yourself, jmux spawns it
as a separate program, and jmux works without it — the feature simply says so
and stays off.

---

## Requirements

Browser panes need
[terminal-browser](https://github.com/zenbu-labs/terminal-browser) installed:

```bash
curl -fsSl https://terminal-browser.sh/install | bash
```

Two things have to be true, and jmux tells you which one is missing rather than
doing nothing:

- **terminal-browser installed.** It is currently **Apple Silicon macOS only** —
  Linux support is [open upstream](https://github.com/zenbu-labs/terminal-browser/pull/4).
  Everything else in jmux works on Linux as it always has; this one feature does
  not yet.
- **A terminal that can draw pictures** — Ghostty, kitty, WezTerm, and anything
  else implementing the kitty graphics protocol.

The `⊙` toolbar button appears only when both are true. `Ctrl-Space b` always
answers, and says which one is missing.

---

## Opening one

| How | What it does |
|-----|--------------|
| `Ctrl-Space b` | Browser pane beside the current one |
| `⊙` in the toolbar | The same |
| `Ctrl-Space p` → **Open browser pane** | The same, from the palette |
| `Ctrl-Space p` → **Open dev server in a browser pane** | Finds what this session is serving and opens it |

Panes are independent. Two browser panes are two browsers, with their own tabs,
history and pages — see [Isolation](#isolation) for why that needs saying.

---

## Driving the browser

These keys go to **terminal-browser**, not to jmux:

| Key | Action |
|-----|--------|
| `⌘L` | Address bar (or click the active tab) |
| `⌘T` | New tab (or click `+` in the tab strip) |
| `⌘R` | Reload |
| `⌥[` / `⌥]` | Back / forward (`⌘` and `Ctrl` also work) |
| `⌘P` | The browser's own command palette |
| `⌘⇧F` | Find in page |
| `⌘⇧I` or `F12` | DevTools — `⌘⌥J` for the console |
| `⌘+` / `⌘−` | Zoom |

Mouse works throughout: click links, scroll pages, drag things. The browser's
palette (`⌘P`) also holds mobile and tablet emulation, and "close pane".

---

## Dev servers

`Ctrl-Space p` → **Open dev server in a browser pane** asks what the current session
is actually listening on and opens it. One match opens straight away; several
give you a picker.

It reads **listening sockets**, not your scrollback. A server that printed its
URL before you scrolled is still found, and a URL sitting in a log line is not
mistaken for one. Ports are attributed to a session by walking the process tree
down from each pane's shell, so what you get is your session's servers rather
than every port on the machine.

The same list, as JSON:

```bash
jmux ctl dev-servers            # this session
jmux ctl dev-servers --all      # every session
```

```json
{
  "scope": "web",
  "servers": [
    { "session": "web", "paneId": "%12", "port": 5173,
      "command": "node", "url": "http://localhost:5173" }
  ]
}
```

The scheme is a guess: a listening socket says nothing about whether TLS is on
it, and `http` is right for almost every dev server. When it's wrong the URL is
right there in the picker and editable in the address bar.

---

## Clicked links

By default a clicked link opens in your **system browser**, exactly as it always
has. To send links to a browser pane instead:

```json
{ "browser": { "openLinks": "pane" } }
```

That navigates the browser pane in the current window, opening one if there
isn't one. It falls back to the system browser whenever a pane isn't possible —
a click that opens nothing is indistinguishable from a click that missed.

---

## Agents

Agents drive browser panes through `jmux ctl browser`:

```bash
jmux ctl browser list                          # panes, tabs, current URLs
jmux ctl browser open http://localhost:5173    # navigate, or open one
jmux ctl browser action -- snapshot            # accessibility tree
jmux ctl browser action -- click @e14
jmux ctl browser action -- fill @e3 "hello"
jmux ctl browser action -- eval "document.title"
```

`action` passes everything after `--` straight through to terminal-browser's
agent-browser CLI, so the vocabulary is that tool's rather than jmux's — and
jmux gains whatever they add without having to model it.

`snapshot` returns an accessibility tree whose entries carry `[ref=e14]`
handles; `click` and `fill` take those as `@e14`.

**Go through `jmux ctl browser`, not `terminal-browser` directly.** See
[Isolation](#isolation).

An agent may open a browser pane, but only beside itself — the split targets the
agent's own pane, so it can show you something in its workspace and cannot
rearrange a session it isn't in.

Full reference: [`skills/jmux-control.md`](../skills/jmux-control.md).

---

## Isolation

Each browser pane gets its own browser process, via its own private
`XDG_RUNTIME_DIR`. This is on by default and it is load-bearing.

Without it, terminal-browser hosts every pane as a *session* of one process and
derives its image id from the process id — so every pane transmits under the
same id and the terminal draws whichever frame arrived last in **all of them**.
Two browser panes show one page. The sessions really are separate underneath,
which is what makes it read as a rendering fault rather than a scoping one.

The cost is real: terminal-browser's instance registry lives in that directory,
so `terminal-browser ls` and `terminal-browser action` run from another pane
find nothing at all. jmux records which directory belongs to which pane, which
is why `jmux ctl browser` works and the bare CLI doesn't.

To trade back — one shared browser, working cross-pane CLI, panes that mirror
each other:

```json
{ "browser": { "isolate": false } }
```

---

## Configuration

All under `browser` in `~/.config/jmux/config.json`:

```json
{
  "browser": {
    "paneSize": 0.62,
    "displayScale": 1,
    "fps": 60,
    "isolate": true,
    "openLinks": "system"
  }
}
```

| Key | Default | What it does |
|-----|---------|--------------|
| `paneSize` | `0.62` | Fraction of the current pane the browser takes (0.2–0.95) |
| `displayScale` | `1` | Device pixel ratio the page is laid out at, or `"auto"` |
| `fps` | `60` | Frame-rate cap, or `"auto"` |
| `isolate` | `true` | A browser process per pane |
| `openLinks` | `"system"` | Where clicked links go — `"system"` or `"pane"` |

**`displayScale`** decides which layout a site picks. Left alone,
terminal-browser uses the display's scale factor — 2 on a Mac — which halves the
CSS viewport and puts a phone layout in a pane wide enough for a desktop one.
jmux asks for `1`: same pixels, same sharpness, laid out for the width it's
actually shown at.

**`fps`** matters more than it looks. Uncapped, terminal-browser renders at the
fastest refresh rate among *all* attached displays — so one ProMotion laptop
panel drives a pane on a 60Hz monitor at 120fps, and every frame is a
whole-canvas image the terminal decodes and blits. It does not stop when the page
is static. Drop it to `30` if a browser pane makes your terminal feel heavy.

A value any of these can't read falls back to the default rather than to
something adjacent, so a typo is a no-op instead of a surprise.

---

## How it works

jmux is the outermost program on your terminal — tmux runs inside a pty jmux
owns — which is what makes any of this possible.

Under tmux, terminal-browser sends the pixels out of band (usually a
shared-memory name, so the payload stays a few hundred bytes at any frame size)
and puts the *position* in a grid of `U+10EEEE` placeholder cells written as
ordinary text. jmux lifts the graphics command out of the PTY stream and relays
it to the real terminal; the placeholder cells travel the normal path, so
scrolling, clipping behind the sidebar, and being covered by a modal all work on
them with no browser-specific code.

Nothing about the relay is browser-specific. Any pane program that speaks the
kitty graphics protocol — image previews in a file manager, a plotting library,
`imgcat` — draws in a jmux pane for the same reason.

Architecture notes live in [CLAUDE.md](../CLAUDE.md#graphics-from-inside-a-pane-browser-panes).

---

## Known limits

- **macOS Apple Silicon only**, until terminal-browser ships Linux support.
- **Focus events don't reach panes.** jmux asks the terminal for them, but tmux
  treats jmux's control-mode client as permanently focused, so there's no
  transition to report. Nothing in a jmux pane — browser or otherwise — is told
  when you focus the window.
- **Cross-pane `terminal-browser` CLI** doesn't work with `isolate` on. Use
  `jmux ctl browser`.
