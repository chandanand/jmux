import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KEYMAP, bindingsBySection, keysFor, shortKeys, type Binding } from "../keymap";
import { buildToolbarButtons } from "../renderer";

// src/keymap.ts is only an *owner* of the keymap if something fails when it
// stops matching reality. Nothing in the type system can check it: the tmux
// binds live in a .conf that tmux executes directly, and the jmux chords live
// in an if-chain whose branches all dispatch to different callbacks. So this
// file does what tmux-conf.test.ts does for the same reason — regex the source
// of truth and compare, in both directions.
//
// Both directions matters. Checking only "every table row exists in the source"
// would pass a router that grew a chord nobody documented, which is exactly how
// `Ctrl-a j` came to be advertised for a bind that was never written.

const ROOT = resolve(import.meta.dir, "..", "..");

// main.ts spawns tmux at import time and so cannot be imported by any unit
// test — the gap boot-smoke.test.ts exists to cover. Several checks below read
// its source instead, which is weaker than calling the function and strictly
// stronger than the nothing that would otherwise be there.
const mainSource = readFileSync(resolve(ROOT, "src", "main.ts"), "utf-8");
const DEFAULTS_CONF = resolve(ROOT, "config", "defaults.conf");
const INPUT_ROUTER = resolve(ROOT, "src", "input-router.ts");

/** Executable lines only — a comment naming a key is usually explaining why it
 * is *not* bound, and a lint that forbade that would be worse than no lint. */
function executableLines(path: string): string[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));
}

/**
 * Every key bound in defaults.conf.
 *
 * Flag handling is the fiddly part: `bind - split-window` binds the key `-`,
 * while `bind -r Left` binds `Left` behind a flag. Single-letter flags match
 * /^-[a-zA-Z]$/, which a bare `-` does not, so the two never collide. `-T`
 * takes a table argument and consumes the token after it.
 */
function confBinds(): string[] {
  const keys: string[] = [];
  for (const line of executableLines(DEFAULTS_CONF)) {
    const trimmed = line.trim();
    if (!/^bind(-key)?\s/.test(trimmed)) continue;
    const tokens = trimmed.split(/\s+/).slice(1);
    let i = 0;
    while (i < tokens.length) {
      if (tokens[i] === "-T") { i += 2; continue; }
      if (/^-[a-zA-Z]$/.test(tokens[i])) { i += 1; continue; }
      break;
    }
    const key = tokens[i];
    // `bind-key C-a send-prefix` binds the prefix to itself so a literal
    // Ctrl-a reaches the pane. It is plumbing for the prefix, not an action a
    // user would look up, and keymap.ts deliberately has no row for it.
    if (key === "C-a") continue;
    if (key) keys.push(key);
  }
  return keys;
}

/**
 * The single-byte keys compared in one of input-router.ts's post-prefix arms,
 * read from between that arm's sentinel comments. Multi-byte matches (escape
 * sequences) and range comparisons are not single keys and are excluded by the
 * regex requiring exactly one character or one escape.
 */
function routerPrefixKeys(arm: "prefix" | "glass-prefix" | "surface-prefix"): string[] {
  const text = readFileSync(INPUT_ROUTER, "utf-8");
  const start = text.indexOf(`--- keymap:${arm} start ---`);
  const end = text.indexOf(`--- keymap:${arm} end ---`);
  expect(start, `missing start sentinel for ${arm}`).toBeGreaterThan(-1);
  expect(end, `missing end sentinel for ${arm}`).toBeGreaterThan(start);

  const region = text.slice(start, end);
  const keys: string[] = [];
  for (const match of region.matchAll(/data === "((?:\\.|[^"\\])+)"/g)) {
    const raw = match[1];
    // \t, \r and \n need their own cases: falling through to the general
    // backslash-strip below turns `data === "\r"` into the printable key
    // "r" — which collides with whatever chord already owns plain "r" and
    // silently misreports both.
    const key =
      raw === "\\t" ? "\t" :
      raw === "\\r" ? "\r" :
      raw === "\\n" ? "\n" :
      raw.replace(/\\(.)/g, "$1");
    if (key.length === 1) keys.push(key);
  }
  return keys;
}

const GLASS_CONTEXT = "Command Center open";

const tmuxBindings = KEYMAP.filter((b) => b.source === "tmux");
const prefixBindings = KEYMAP.filter((b) => b.prefixKey !== undefined);
const glassPrefixBindings = prefixBindings.filter((b) => b.context === GLASS_CONTEXT);

const sorted = (xs: string[]): string[] => [...xs].sort();

describe("keymap ↔ defaults.conf", () => {
  test("a tmux-default binding is never claimed to come from defaults.conf", () => {
    // The escape hatch has to stay narrow: `tmux-default` exempts a row from
    // the conf check, so a row that wrongly used it would document a key
    // nothing verifies. A row carrying `conf` is asserting the opposite.
    const mislabelled = KEYMAP.filter((b) => b.source === "tmux-default" && b.conf).map((b) => b.id);
    expect(mislabelled).toEqual([]);
  });

  test("every tmux binding in the table is bound in defaults.conf", () => {
    const bound = new Set(confBinds());
    const undocumented = tmuxBindings
      .filter((b) => !bound.has(b.conf!))
      .map((b) => `${b.keys} (conf: ${b.conf})`);
    expect(undocumented).toEqual([]);
  });

  test("every bind in defaults.conf appears in the table", () => {
    const tabled = new Set(tmuxBindings.map((b) => b.conf));
    const missing = confBinds().filter((k) => !tabled.has(k));
    expect(missing).toEqual([]);
  });

  test("every tmux binding declares the conf key it came from", () => {
    const undeclared = tmuxBindings.filter((b) => !b.conf).map((b) => b.id);
    expect(undeclared).toEqual([]);
  });
});

describe("keymap ↔ input-router", () => {
  // A chord declared for both arms could pass an equality check against the
  // ordinary arm and a subset check against the glass arm while being absent
  // from one of them outright — the two checks never actually agree with each
  // other on any single binding. This is the arm matrix instead: each
  // prefix-bearing row declares the arms it belongs to (`Binding.arms`), and
  // this asserts that set, per binding, against which arms actually intercept
  // its key.
  //
  // The complication is that a byte can mean two different things in two
  // different arms — `G`/`s`/`f` dispatch to the sidebar's own cycle in the
  // ordinary arm and to the Command Center's in the glass arm, one row each.
  // A Command-Center-context row's key therefore only ever counts as reaching
  // the glass arm; a same-key row without that context only counts as
  // reaching the glass arm if no Command-Center-context row has already
  // claimed the byte there.
  type Arm = "prefix" | "glass-prefix" | "surface-prefix";
  const armBytes: Record<Arm, ReadonlySet<string>> = {
    prefix: new Set(routerPrefixKeys("prefix")),
    "glass-prefix": new Set(routerPrefixKeys("glass-prefix")),
    "surface-prefix": new Set(routerPrefixKeys("surface-prefix")),
  };
  const glassClaimedKeys = new Set(
    prefixBindings.filter((b) => b.context === GLASS_CONTEXT).map((b) => b.prefixKey!),
  );

  function actualArms(b: Binding): Set<Arm> {
    const out = new Set<Arm>();
    if (b.context === GLASS_CONTEXT) {
      if (armBytes["glass-prefix"].has(b.prefixKey!)) out.add("glass-prefix");
      return out;
    }
    if (armBytes["prefix"].has(b.prefixKey!)) out.add("prefix");
    if (armBytes["surface-prefix"].has(b.prefixKey!)) out.add("surface-prefix");
    if (armBytes["glass-prefix"].has(b.prefixKey!) && !glassClaimedKeys.has(b.prefixKey!)) {
      out.add("glass-prefix");
    }
    return out;
  }

  test("every prefix binding declares at least one arm", () => {
    const undeclared = prefixBindings.filter((b) => !b.arms || b.arms.length === 0).map((b) => b.id);
    expect(undeclared).toEqual([]);
  });

  test("every prefix binding's declared arms match the arms that actually intercept it", () => {
    const ARM_OF: Record<NonNullable<Binding["arms"]>[number], Arm> = {
      ordinary: "prefix",
      glass: "glass-prefix",
      surface: "surface-prefix",
    };
    const mismatches: string[] = [];
    for (const b of prefixBindings) {
      const declared = new Set((b.arms ?? []).map((a) => ARM_OF[a]));
      const actual = actualArms(b);
      const declaredSorted = sorted([...declared]);
      const actualSorted = sorted([...actual]);
      if (JSON.stringify(declaredSorted) !== JSON.stringify(actualSorted)) {
        mismatches.push(`${b.id}: declared [${declaredSorted}] actual [${actualSorted}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  // The per-binding matrix above only walks bindings that already exist in
  // the table — a chord added straight to a router arm with no Binding row at
  // all has nothing to iterate over and is invisible to it. That is exactly
  // the drift this file exists to prevent (`Ctrl-a j`, advertised for a bind
  // that was never written), so the router→table direction needs its own
  // check per arm: every byte an arm actually intercepts must be claimed by
  // at least one row that declares *that* arm.
  test("every key the ordinary prefix arm intercepts is declared by some binding for that arm", () => {
    const declared = new Set(
      prefixBindings.filter((b) => (b.arms ?? []).includes("ordinary")).map((b) => b.prefixKey),
    );
    const missing = routerPrefixKeys("prefix").filter((k) => !declared.has(k));
    expect(missing).toEqual([]);
  });

  test("every key the glass prefix arm intercepts is declared by some binding for that arm", () => {
    const declared = new Set(
      prefixBindings.filter((b) => (b.arms ?? []).includes("glass")).map((b) => b.prefixKey),
    );
    const missing = routerPrefixKeys("glass-prefix").filter((k) => !declared.has(k));
    expect(missing).toEqual([]);
  });

  test("every Command Center chord in the table is intercepted in the glass arm", () => {
    const intercepted = new Set(routerPrefixKeys("glass-prefix"));
    const missing = glassPrefixBindings
      .filter((b) => !intercepted.has(b.prefixKey!))
      .map((b) => b.keys);
    expect(missing).toEqual([]);
  });

  test("every key the full-screen-surface arm intercepts is in the table", () => {
    // Subset, unlike the ordinary/glass checks above: this arm is a
    // deliberate handful of chords that stay live while
    // settings/workflow/ghost-preview own input, not a second copy of the
    // keymap, so this only checks that every byte it intercepts has *some*
    // row in the table — not one that declares "surface" among its arms.
    // What it must never be is a chord nothing documents at all.
    const tabled = new Set(prefixBindings.map((b) => b.prefixKey));
    const missing = routerPrefixKeys("surface-prefix").filter((k) => !tabled.has(k));
    expect(missing).toEqual([]);
  });

  test("the surface arm stays a strict subset of the ordinary prefix chain", () => {
    // A chord live on a surface but not on the normal frame would be
    // unreachable from the place users actually learn it.
    const plain = new Set(routerPrefixKeys("prefix"));
    const stray = routerPrefixKeys("surface-prefix").filter((k) => !plain.has(k));
    expect(stray).toEqual([]);
  });

  test("Ctrl-a ? reaches the help overlay from both arms", () => {
    // The regression this pins: the overlay was advertised by footer.ts for
    // months with no handler behind it anywhere.
    expect(routerPrefixKeys("prefix")).toContain("?");
    expect(routerPrefixKeys("glass-prefix")).toContain("?");
  });
});

describe("keymap ↔ command palette", () => {
  // The palette stamps each row's key by matching Binding.id against
  // PaletteCommand.id, so an id that drifts silently loses its key. This is
  // the class of bug that let docs/cheat-sheet.md advertise a "window picker"
  // palette command that buildPaletteCommands has never built.
  //
  // It has to be a source grep, for the reason given at `mainSource` above.
  const PALETTE_BACKED_IDS = [
    "new-session", "new-window", "split-h", "split-v", "browser-pane",
    "settings-screen", "help", "diff-toggle", "diff-zoom", "start-up-next",
  ] as const;

  test("the ids that are meant to carry a palette key all exist in the table", () => {
    const tabled = new Set(KEYMAP.map((b) => b.id));
    const missing = PALETTE_BACKED_IDS.filter((id) => !tabled.has(id));
    expect(missing).toEqual([]);
  });

  test("each of those ids is still a real palette command", () => {
    const missing = PALETTE_BACKED_IDS.filter((id) => !mainSource.includes(`id: "${id}"`));
    expect(missing).toEqual([]);
  });
});

describe("keymap ↔ toolbar buttons", () => {
  // Hovering a toolbar button names it and its chord by resolving the button's
  // id against the keymap (main.ts's toolbarHoverHint). A button whose id has
  // no binding silently shows nothing — the same quiet miss the rest of this
  // file exists to prevent, and the easier one to introduce, since adding a
  // button touches neither the keymap nor the router.
  //
  // `panel` is the one deliberate alias: the button is `panel`, the binding is
  // the palette command `diff-toggle`. Mirrors main.ts's TOOLBAR_BUTTON_BINDING.
  const ALIASES: Record<string, string> = { panel: "diff-toggle" };

  /**
   * Every button jmux can draw, including the ones behind an availability
   * flag. Asking for the default set would quietly stop covering a button the
   * moment one is added conditionally — which is exactly how the browser
   * button shipped with no click handler.
   */
  const allButtons = () => buildToolbarButtons({ panelActive: false, browserAvailable: true });

  test("every toolbar button resolves to a binding", () => {
    const tabled = new Set(KEYMAP.map((b) => b.id));
    const unresolved = allButtons()
      .map((b) => ALIASES[b.id] ?? b.id)
      .filter((id) => !tabled.has(id));
    expect(unresolved).toEqual([]);
  });

  test("the alias map names only buttons that actually exist", () => {
    // A stale alias is dead weight that reads as a live constraint.
    const buttonIds = new Set(allButtons().map((b) => b.id));
    const stale = Object.keys(ALIASES).filter((id) => !buttonIds.has(id));
    expect(stale).toEqual([]);
  });

  // Resolving to a *binding* only makes the hover hint work. Clicking goes
  // somewhere else entirely — main.ts's handleToolbarAction — and a button
  // missing from that switch looks completely normal until it is pressed and
  // does nothing. That shipped: `browser-pane` was added to the palette's
  // handler and the toolbar's, and only the palette dispatched it.
  //
  // A source grep for the same reason the palette check above is one: the
  // switch lives in main.ts, which no unit test can import.
  test("every toolbar button is dispatched by handleToolbarAction", () => {
    const body = mainSource.slice(mainSource.indexOf("async function handleToolbarAction"));
    const end = body.indexOf("\n}\n");
    const dispatched = new Set(
      [...body.slice(0, end).matchAll(/case "([^"]+)":/g)].map((m) => m[1]),
    );
    const undispatched = allButtons()
      .map((b) => b.id)
      .filter((id) => !dispatched.has(id));
    expect(undispatched).toEqual([]);
  });
});

describe("keymap internal consistency", () => {
  test("ids are unique", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const b of KEYMAP) {
      if (seen.has(b.id)) dupes.push(b.id);
      seen.add(b.id);
    }
    expect(dupes).toEqual([]);
  });

  test("no two bindings claim the same keys in the same context", () => {
    const seen = new Map<string, Binding>();
    const collisions: string[] = [];
    for (const b of KEYMAP) {
      const scope = `${b.context ?? "global"}::${b.keys}`;
      const prior = seen.get(scope);
      if (prior) collisions.push(`${b.keys} — ${prior.id} vs ${b.id}`);
      seen.set(scope, b);
    }
    expect(collisions).toEqual([]);
  });

  test("every binding has a label and a section", () => {
    const bad = KEYMAP.filter((b) => !b.label.trim() || !b.section.trim()).map((b) => b.id);
    expect(bad).toEqual([]);
  });

  test("bindingsBySection covers every binding exactly once", () => {
    const grouped = bindingsBySection().flatMap((s) => s.bindings);
    expect(grouped.length).toBe(KEYMAP.length);
    expect(sorted(grouped.map((b) => b.id))).toEqual(sorted(KEYMAP.map((b) => b.id)));
  });

  test("sections are contiguous — a section is never reopened", () => {
    // bindingsBySection merges by name, so a split section would silently
    // reorder rows relative to the authored table. Cheaper to forbid.
    const order = KEYMAP.map((b) => b.section);
    const firstSeen = new Map<string, number>();
    const reopened: string[] = [];
    for (let i = 0; i < order.length; i++) {
      const at = firstSeen.get(order[i]);
      if (at === undefined) firstSeen.set(order[i], i);
      else if (order[i - 1] !== order[i]) reopened.push(order[i]);
    }
    expect(reopened).toEqual([]);
  });

  test("keysFor resolves a known id and returns undefined otherwise", () => {
    expect(keysFor("palette")).toBe("Ctrl-a p");
    expect(keysFor("no-such-command")).toBeUndefined();
  });
});

describe("shortKeys", () => {
  test("compacts the prefix without mangling the chord key", () => {
    expect(shortKeys("Ctrl-a p")).toBe("^a p");
    // The ordering trap: a general Ctrl- rule applied first would leave "^a p"
    // by luck here but break "Ctrl-a Left", whose "a" is not a modifier.
    expect(shortKeys("Ctrl-a Left")).toBe("^a ←");
  });

  test("compacts standalone modifiers and arrows", () => {
    expect(shortKeys("Ctrl-Shift-Up")).toBe("^⇧↑");
    expect(shortKeys("Shift-Right")).toBe("⇧→");
    expect(shortKeys("Ctrl-Right")).toBe("^→");
  });

  test("leaves bare keys alone", () => {
    expect(shortKeys("[")).toBe("[");
    expect(shortKeys("o")).toBe("o");
  });
});
