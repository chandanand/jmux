# Settings editor controls

Date: 2026-08-12

## Problem

Every numeric setting in jmux is edited by typing into a text field.

`Ctrl-a i` opens the settings screen, `↑↓` walks the rows, and `Enter` on
"Sidebar width" opens an edit buffer seeded with `26`. To make the sidebar one
column wider you press Enter, backspace twice, type `27`, press Enter. There is
no way to nudge a value and watch what it does; the only way to find out what
26 looks like against 30 is to type both and compare from memory.

The screen already knows how to do better. `SettingDef.onStep` exists, is
documented, and is rendered by the workflow screen — a selected steppable row
there wears `◂ 3 per stage ▸` and the footer says `◂▸ change`. The settings
screen never got the other half: `handleInput` has no case for `\x1b[C` or
`\x1b[D` at all, so Left and Right are swallowed in navigation mode. Two
surfaces built on one `SettingDef`, and only one of them can nudge a value.

### The bug that follows from it

Text editing means each row hand-writes four things that have to agree: what it
displays, what it seeds the edit buffer with, how it parses what comes back, and
how it clamps the result. `SettingDef.getEditValue` exists precisely because
display form and input form are not the same string, and its doc comment spells
out the failure:

> a commit parses "never" to NaN, and typing a number onto the end of it yields
> "never5"

Panel width has no `getEditValue`. It displays `auto` when `infoPanelWidth` is
null, so Enter seeds the buffer with `auto`; typing `55` yields `auto55`;
`parseInt` returns NaN; the commit does nothing and says nothing. **The panel
width cannot be set from its own prompt** unless the user first knows to clear
the word. The documented trap, on the row below the one documenting it.

It is in two places, not one. The command palette's "Panel Width" modal
(`main.ts:8131`) seeds `infoPanelWidth !== null ? String(infoPanelWidth) :
"auto"` and parses it the same way, so it fails identically. The bounds
themselves — `>= 10 && <= 60` for the sidebar, `>= 20 && <= 120` for the panel —
are written out three times across the settings row and the two palette modals,
with the range also restated as English in each modal's subheader. Five copies
of two numbers.

### Three smaller dishonesties

**`list` costs three keystrokes to commit one of three options.** Enter enters a
mode, `◂ ▸` cycles, Enter commits. That is the right shape for the tracker-state
rows, which choose among twenty-five workspace-defined statuses; it is the wrong
shape for "Running state colour".

**Three Diagnostics rows are `type: "text"` with no `onTextCommit`.** They are
read-only status reports. Enter does nothing at all, while the hint line at the
bottom of the screen says `↵ edit`. A row that announces an action and silently
declines is the failure `sectionedViewNotice()` was written to prevent.

**A numeric row states no bounds.** `10–60` appears in the palette modal's
subheader and nowhere on the settings screen, so the row that actually enforces
the range is the one that never mentions it. Out-of-range input is discarded in
silence.

### The naming command has no row at all

`sessionTitle.command` is configurable only by hand-editing
`~/.config/jmux/config.json`. The setup hint says so outright:

> Set sessionTitle.command in ~/.config/jmux/config.json, e.g. ["claude", "-p"].

`resolveTitleConfig` was written because every way that value can be wrong fails
silently and identically — a string instead of an array spreads into argv
`["c","l","a",…]` and ENOENTs into the silent-failure rule. It validates, warns
and clamps, which turns a broken value into a message. It cannot help with a
value that is well-formed and simply does not produce a usable title, and it
does not exist for the user who never discovers the setting.

## Approach

**One rule: `◂ ▸` always changes the selected row's value. `Enter` is only for
values you must type or search.**

For that to be a rule and not a habit it has to hold for every row type:

| type | `◂ ▸` | `Enter` |
| --- | --- | --- |
| `boolean` | toggles | toggles |
| `number` *(new)* | steps the ladder, applied live | type an exact value |
| `list` | cycles and commits live | filterable picker |
| `multiselect` | — | picker |
| `text` | — | edit buffer |
| `map` | — | expand / collapse |
| `action` | — | run |
| `info` *(new)* | — | — |

`text`, `multiselect` and `map` have no ordered ladder to walk, so they honestly
do not step. The hint line names what the *selected* row takes, so a row never
advertises a key it does not have — which is the same reason the workflow
screen's footer varies by row kind rather than listing every key it knows.

This **deletes** the settings screen's inline list mode: `EditState`'s
`{ mode: "list" }` variant, `renderListEdit`, and the list branch of
`handleEditInput`. `list` rows cycle in place with `◂ ▸`, and `Enter` opens the
filterable picker the screen already runs for `multiselect`. Long lists get
search instead of a cycle; short ones get one keypress instead of three. Neither
needs a bespoke mode.

`SettingDef` gains fields and loses none, so the workflow screen and
`buildRepoRows` keep working untouched.

## `src/setting-number.ts`

The panel-width bug is possible because display, edit-buffer, parse and clamp
are four hand-written things per row. One spec generates all four, so they
cannot disagree:

```ts
export interface NumberSpec {
  min: number;
  max: number;
  step?: number;              // default 1
  unit?: string;              // "rows", "days", "chars"
  /** A rung below `min` — "auto", "never". */
  low?:  { label: string; store: unknown };
  /** A rung above `max` — "all". */
  high?: { label: string; store: unknown };
}
```

Five pure functions over it: `formatNumber` (the display form),
`editNumber` (the edit-buffer form), `parseNumber` (stored value, clamped,
sentinel words accepted), `stepNumber` (one rung), and `rangeHint` (`(10–60)`,
`(auto, 20–120)`).

`editNumber` returns `""` for a sentinel. That single line is what makes
`auto55` unrepresentable: there is no state in which the buffer contains a word
that a number can be typed onto.

`numberSetting({ id, label, spec, read, write, describe })` assembles a complete
`SettingDef` with `getValue`, `getEditValue`, `onTextCommit` and `onStep` all
derived from the one spec. A row becomes a declaration:

```ts
numberSetting({
  id: "panel-width", label: "Panel width",
  spec: { min: 20, max: 120, low: { label: "auto", store: undefined } },
  read:  () => infoPanelWidth,
  write: (v) => applyPanelWidth(v),
  describe: () => "Width of the issue panel. auto tracks the terminal.",
})
```

The two command-palette modals read the same spec — `rangeHint()` for the
subheader, `editNumber()` for the seed, `parseNumber()` for the commit — so the
bounds exist once and the palette's copy of the seeding bug goes with them.

### `stepNumber` clamps; it does not wrap

`stepGhostCap` wraps, deliberately: its two sentinels are semantically adjacent,
so `all` is one press left of `never` rather than ninety-nine presses right of
it. That reasoning is a property of a ladder with a sentinel at *both* ends — a
closed loop. A bare range is not one, and jumping 60 → 10 while a key is held
down is a surprise, not a shortcut.

**`stepGhostCap` is not migrated.** It is tested domain logic in `ghosts.ts` with
its own documented reasoning, read by more than one caller, and it starts working
on the settings screen for free the moment `◂ ▸` is wired — there is nothing to
gain by rewriting it into a spec that would need custom labels to reproduce what
it already does.

### Rows that convert

| row | spec |
| --- | --- |
| `sidebar-width` | `min 10, max 60` |
| `panel-width` | `min 20, max 120, low: auto` |
| `image-max-rows` | `min 1, max 60, unit "rows"` |
| `auto-park-idle` | `min 1, max 365, unit "days", low: never` |
| `title-max-chars` *(new)* | `min 8, max 200, unit "chars"` |

`agent-pane-regex` and `project-dirs` stay `text` — they are genuinely free
input, and a stepper over them would be a lie.

The three Diagnostics rows become `type: "info"`, which takes no edit and
contributes no edit key to the hint line.

## Live apply, debounced persist

Each `◂ ▸` press assigns the module-level variable and relayouts synchronously,
so the sidebar visibly moves while the key is held; the `configStore.set` is
coalesced and fires once the presses stop.

This is the order the drag handle already uses, and the reason is the same one
recorded for it: `main.ts` assigns the module width *before* `configStore.set`,
so the config watcher sees no change and does not fire a second resize. Reusing
the order preserves that guarantee. `persistDragWidth` is the existing
end-of-gesture write; the stepper gets the same treatment with a trailing timer
rather than a mouse-up to hang it on.

The timer is trailing-only at 250ms, deliberately unlike `scheduleDragResize`'s
leading-plus-trailing throttle. A drag needs its *first* movement to be instant
because the pointer is already moving; a keypress is discrete and already
applied live, so the only thing the timer governs is the disk write, and a
leading edge there would write on the first press of every burst for nothing.
The screen closing flushes a pending write rather than dropping it.

`infoPanelWidth`'s "unset" write is `configStore.set("infoPanelWidth", undefined
as any)` in all three current call sites. `ConfigStore.delete()` exists and is
typed. The `low.store: undefined` rung routes through it, and the `as any` casts
go — debt in the path of the work.

## Layout

Two rows are reserved at the bottom instead of one:

```
row 0            Settings
row 1            (blank)
rows 2 … n-3     content
row n-2          explain line — the selected row's describe(), dim
row n-1          hint line — the keys the selected row actually takes
```

The explain row is **always reserved, blank or not**. A hint line that moves as
the cursor travels is worse than one dim empty row, and the alternative — only
reserving it when `describe()` is non-null — makes the content area's height
depend on which row is selected, which `ensureVisible` would then have to
model.

`render()` and `ensureVisible()` both derive the content height from a shared
`BOTTOM_RESERVED_ROWS = 2` beside the existing `CONTENT_START_ROW`, for the
reason that constant's own comment gives: the two must not be able to drift.

Bounds render inline on the selected stepper, next to the control that enforces
them:

```
▸ Sidebar width ················ ◂ 26 ▸ (10–60)
  Panel width ·················· auto
```

`◂ ▸` and the range appear on the selected row only. On every row at once they
read as decoration and add two columns of noise to rows that do not step — the
same judgement the workflow screen already records for its own brackets.

Settings rows that have no `describe()` get one written as part of this work, so
the reserved line earns its row.

## Session titles

A new category with three rows.

### Naming command

A `list` over `off · claude · codex · custom…`.

**A preset stores full argv, never a preset name.** The row reads back which
preset is active by matching the stored `string[]` against the table; no match
displays `custom`. So `sessionTitle.command` keeps the shape it has today,
`resolveTitleConfig` is untouched, there is no migration and no second source of
truth, and `config.json` stays legible to someone who has never seen the picker.
The preset table is an authoring convenience on top of a value that remains
plain argv.

`off` stores nothing, which is already the entire off switch — `sessionTitle.command`
unset is what turns the feature off, and the config watcher's hot-apply at
`main.ts:8909` and the `@jmux-title-capture` gate both follow from it with no
extra wiring.

Two presets, both run end to end on a real terminal:

```
claude   claude -p --model haiku --effort low --tools ""
codex    codex exec --skip-git-repo-check --ephemeral -s read-only \
                    -c model_reasoning_effort=none -
```

Measured 11.5s and 6.1s respectively for a five-word reply, against a 60s
default timeout. `codex` writes its session preamble, hook log and token count
to **stderr** and only the final message to stdout, which is exactly what
`spawnTitleRunner` wants — it already sets `stderr: "ignore"`.
`--skip-git-repo-check` is load-bearing rather than defensive: `titleRunnerCwd()`
returns `tmpdir()`, which is not a repository, and codex refuses to run in one
without it.

Nothing else ships as a preset. `pi`, `gemini` and `opencode` are installed on
the development machine but unauthenticated, so their flags could be read off a
real `--help` while their output shape could not be verified; `grok` is not
installed at all. This is the rule `agent-screen.ts` already states for its
signature table — only add a built-in you have read off a real terminal, because
an unverified entry produces a confident wrong answer instead of an honest
blank. Every one of them is still reachable through `custom…`.

`custom…` opens the text editor seeded with the current argv joined by spaces,
with the explain line carrying the contract: the prompt arrives on stdin, the
title is read from stdout, and the string is split on spaces into argv.

**`◂ ▸` cycles only among concrete values; `custom…` is reachable through
`Enter`'s picker alone.** So the ladder is `off · claude · codex`, plus the
stored custom argv as a fourth rung when one exists. This keeps `◂ ▸`'s meaning
intact everywhere — every press lands on a value that is now in force. A cycle
that stepped onto `custom…` would either pop a text editor mid-cycle or leave
the row naming an option that is not a setting, and the row is the one control
here whose wrong value fails silently.

### Title length

A stepper, 8–200, unit `chars`, over `sessionTitle.maxChars`.

`MAX_CHARS_DEFAULT`, `MAX_CHARS_MIN` and `MAX_CHARS_MAX` are module-private
constants in `generator.ts` today. They get exported and the row's spec reads
them, rather than the bounds being retyped — otherwise the row would offer a
range that `resolveTitleConfig` then clamps differently, which is the same class
of failure as `buildTitlePrompt` reading raw config instead of the clamped
budget.

### Test naming command

An `action` row that runs the configured argv through the same
`spawnTitleRunner` and `parseTitle` against a fixed sample prompt, and reports
what came back — the parsed title, or the reason there wasn't one.

This is the row that makes the other two honest. The subsystem's governing rule
is that an *automatic* naming failure is silent, because `requestSessionTitles`
runs on every poll and one unreachable command would otherwise report itself
forever. That rule is right, and it means a `custom…` command which returns a
preamble line, or ANSI colour, or nothing, has no way to announce itself. An
explicit test is an explicit request, so it answers — the same distinction
`TitleGenerator.request`'s `explicit` flag already draws, and the same
disclosure discipline as `parkingSetupWarning`, `driftSetupWarning` and
`adapterRestartNote`.

It reports through `parseTitle` rather than showing raw stdout, so what the user
reads is what would actually be stored — a command whose output survives the
escape strip and the control-character delete only as an empty string reports
"returned nothing usable", which is the honest answer and the one the row would
have acted on.

The result goes to `showToast` — a title is a short phrase and a failure reason
is one clause, and the row is read on a screen that is about to be closed. The
full stdout and the exit code go to `jmux.log` alongside it, since that is where
`logError` already sends the naming failures this row exists to make visible.
The row reports `running…` while the call is in flight: it is spawning an agent
CLI, measured at 6–12s, and a control that looks inert for ten seconds is the
problem this whole spec is about.

## Testing

Pure unit tests over the logic modules, matching what `settings-screen.test.ts`
already does with fake `SettingDef`s. No test spawns tmux.

**`setting-number.test.ts`** — the round trip is the point, so every
composition is asserted rather than each function alone:
`parseNumber(editNumber(v)) === v` across both sentinels and both bounds;
`stepNumber` clamps at each end and never yields a value `parseNumber` would
reject; `format`/`edit` differ exactly where a sentinel is stored. The
regression case is explicit: with `low: auto` stored, `editNumber` returns `""`,
so the sequence that produced `auto55` cannot be constructed.

**`title-presets.test.ts`** — argv ↔ preset matching in both directions, and
that an unrecognised argv reports `custom` rather than falling back to a preset
it does not equal.

**`settings-screen.test.ts` additions** — `◂ ▸` steps a `number` row and toggles
a `boolean`; `◂ ▸` on a `text` row changes nothing; an `info` row takes no edit
on Enter and contributes no edit key to the hint; `Enter` on a `list` opens the
picker rather than an inline mode; the reserved explain row does not consume a
content row or desynchronise `ensureVisible`'s scroll clamp.

`main.ts` is unreachable by unit tests, as ever, so the row *definitions* are
covered only by the boot smoke test staying green. That is the reason the specs
and the preset table live in their own modules rather than inline in the row
literals.

## Decisions taken without being asked

**No mouse support.** The settings screen has none today, and clicking a `◂ ▸`
would be a new hit-testing path on a surface that has no click routing at all.
Out of scope; the rule this spec adds is a keyboard rule.

**`list` keeps `◂ ▸` even at twenty-five options.** The workflow screen records
that cycling twenty-five tracker states one press at a time is why nobody found
those rows, and that judgement is why `Enter` opens a searchable picker here.
But that argues against a cycle being the *only* way in, not against its
existing beside a picker. A user who wants the next state gets one press; a user
who wants a distant one types three letters.

**The explain line is reserved rather than conditional.** Stated above under
Layout: a jumping hint line costs more than a blank row, and a content height
that varies with the selected row is a scroll-clamp bug waiting to be written.

**`project-dirs` stays a comma-joined text field.** It is a list of paths and
would read better as a `map`-style expanding row with a directory picker — the
machinery exists, `team-repo-map` uses it. It is not in the path of this change,
and converting it would grow the diff past what the request needs. Flagged, not
done.

**CLAUDE.md gains a section on the row dialect.** The `◂ ▸` / `Enter` split, the
one-spec-four-forms rule and the argv-not-preset-name storage are all rules that
a later change could plausibly undo without noticing, which is the bar that file
already documents everything else against.
