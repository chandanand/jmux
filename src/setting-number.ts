// Numeric settings: one spec, four derived forms.
//
// A numeric row has to agree with itself about four things — what it displays,
// what it seeds an edit buffer with, how it parses what comes back, and how it
// clamps the result. Written out per row, those drift, and the drift is silent:
// the panel width row displayed "auto", seeded its prompt with "auto", and a
// typed digit produced "auto55", which parses to NaN and commits nothing. The
// setting could not be changed from its own prompt, with no error anywhere.
//
// So all four come from one `NumberSpec`. `editNumber` returning "" for a
// sentinel is the line that matters: there is no state in which the buffer
// holds a word that a digit can be typed onto.
//
// See docs/superpowers/specs/2026-08-12-settings-editor-controls-design.md.

import type { SettingDef } from "./settings-screen";

/** A value off the ends of the ladder — "auto", "never", "all". */
export interface Sentinel {
  label: string;
  /** What lands in config. `undefined` means the key is deleted. */
  store: unknown;
}

export interface NumberSpec {
  min: number;
  max: number;
  /** How far one ◂ ▸ press moves. Default 1. */
  step?: number;
  /** Plural noun, e.g. "days". Singularised for a count of one. */
  unit?: string;
  /** The rung below `min`. */
  low?: Sentinel;
  /** The rung above `max`. */
  high?: Sentinel;
}

type Reading =
  | { kind: "low" }
  | { kind: "high" }
  | { kind: "num"; n: number };

/**
 * What a stored value means on this spec's ladder.
 *
 * Anything unreadable — a hand-edited config, a key that has never been set —
 * reads as the low sentinel where there is one and the minimum where there is
 * not, so a row always has something honest to render rather than throwing on
 * a file the user is free to edit by hand.
 */
function read(spec: NumberSpec, stored: unknown): Reading {
  if (spec.low && Object.is(stored, spec.low.store)) return { kind: "low" };
  if (spec.high && Object.is(stored, spec.high.store)) return { kind: "high" };
  if (typeof stored === "number" && Number.isFinite(stored)) {
    return { kind: "num", n: Math.round(stored) };
  }
  return spec.low ? { kind: "low" } : { kind: "num", n: spec.min };
}

/** The unit, agreeing with the quantity in front of it. */
function unitFor(spec: NumberSpec, n: number): string {
  if (!spec.unit) return "";
  const word = n === 1 && spec.unit.endsWith("s") ? spec.unit.slice(0, -1) : spec.unit;
  return ` ${word}`;
}

/** What the row displays. */
export function formatNumber(spec: NumberSpec, stored: unknown): string {
  const r = read(spec, stored);
  if (r.kind === "low") return spec.low!.label;
  if (r.kind === "high") return spec.high!.label;
  return `${r.n}${unitFor(spec, r.n)}`;
}

/**
 * What the edit prompt opens on — the *input* form, which is not the display
 * form. A sentinel opens empty rather than on its own label, so typing a digit
 * produces a number instead of "auto55"; a count opens bare, with no unit for
 * the cursor to land after.
 */
export function editNumber(spec: NumberSpec, stored: unknown): string {
  const r = read(spec, stored);
  return r.kind === "num" ? String(r.n) : "";
}

/**
 * Parse what the user typed, into what gets stored.
 *
 * Lenient about case, spacing, and a trailing unit, because the row displays
 * one ("3 days") and re-typing what you just read should work. `current` is
 * returned for input that means nothing at all, so a stray keystroke committed
 * by accident leaves the setting where it was rather than resetting it.
 *
 * Zero and below mean the low sentinel where there is one — "0 days" is a
 * request to turn the setting off, and clamping it up to the minimum would
 * switch on the thing the user was switching off. A positive number under the
 * minimum is a different intent ("as small as possible") and clamps.
 *
 * **An empty buffer means "cleared", which on a row that opened empty means
 * nothing at all.** `editNumber` seeds a sentinel with "", so a prompt opened
 * on one and committed untouched must give that same sentinel back. Reading
 * empty as the low rung unconditionally instead silently demoted "all" to
 * "never" on an Enter that typed nothing — the setting changing itself because
 * it was looked at.
 */
export function parseNumber(spec: NumberSpec, input: string, current?: unknown): unknown {
  const raw = input.trim().toLowerCase();
  if (spec.low && raw === spec.low.label.toLowerCase()) return spec.low.store;
  if (spec.high && raw === spec.high.label.toLowerCase()) return spec.high.store;
  if (raw === "") {
    const r = read(spec, current);
    if (r.kind === "low") return spec.low!.store;
    if (r.kind === "high") return spec.high!.store;
    return spec.low ? spec.low.store : current;
  }

  const n = parseInt(raw, 10);
  if (isNaN(n)) return current;
  if (n <= 0 && spec.low) return spec.low.store;
  if (n < spec.min) return spec.min;
  if (n > spec.max) return spec.high ? spec.high.store : spec.max;
  return n;
}

/**
 * One rung along the ladder `[low] min … max [high]`.
 *
 * **Clamps at both ends; does not wrap.** `stepGhostCap` wraps deliberately —
 * its two sentinels are semantically adjacent, so `all` sits one press left of
 * `never` instead of ninety-nine presses right of it. That reasoning belongs to
 * a ladder closed at both ends. A bare range is not a loop, and 60 → 10 under a
 * held key is a surprise rather than a shortcut.
 *
 * A stored value off the top of the ladder (typed, not stepped) is pulled onto
 * it before moving, so stepping from it goes somewhere adjacent rather than
 * snapping to an end.
 */
export function stepNumber(spec: NumberSpec, stored: unknown, delta: number): unknown {
  const r = read(spec, stored);
  const step = spec.step ?? 1;

  if (r.kind === "low") return delta > 0 ? spec.min : spec.low!.store;
  if (r.kind === "high") return delta < 0 ? spec.max : spec.high!.store;

  const from = Math.min(spec.max, Math.max(spec.min, r.n));
  const next = from + delta * step;
  if (next < spec.min) return spec.low ? spec.low.store : spec.min;
  if (next > spec.max) return spec.high ? spec.high.store : spec.max;
  return next;
}

/**
 * The bounds, rendered beside the control that enforces them. The settings
 * screen shows this on the selected row only — the range that used to live
 * solely in a command-palette subheader, on the surface that actually applies
 * it.
 */
export function rangeHint(spec: NumberSpec): string {
  const parts: string[] = [];
  if (spec.low) parts.push(spec.low.label);
  parts.push(`${spec.min}–${spec.max}${spec.unit ? ` ${spec.unit}` : ""}`);
  if (spec.high) parts.push(spec.high.label);
  return `(${parts.join(", ")})`;
}

/**
 * Why this input cannot be used, or null if it can.
 *
 * `parseNumber` clamps, because stepping and the command-palette modals have
 * nowhere to put a complaint — a press at the maximum has to stop there. A
 * settings row does have somewhere: `onTextCommit` returns a message to reject,
 * and typing 200 into a 10–60 field should say so rather than quietly become
 * 60. Same reasoning as the rejection contract itself — a value that vanishes
 * into a different one looks applied when it isn't.
 */
export function validateNumber(spec: NumberSpec, input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (raw === "") return null;
  if (spec.low && raw === spec.low.label.toLowerCase()) return null;
  if (spec.high && raw === spec.high.label.toLowerCase()) return null;
  const n = parseInt(raw, 10);
  if (isNaN(n)) return `must be a number ${rangeHint(spec)}`;
  if (n <= 0 && spec.low) return null;
  if (n < spec.min || n > spec.max) return `must be ${rangeHint(spec).slice(1, -1)}`;
  return null;
}

export interface NumberSettingOpts {
  id: string;
  label: string;
  spec: NumberSpec;
  read: () => unknown;
  write: (value: unknown) => void;
  describe?: () => string;
  getScope?: () => "inherited" | "override";
  onClearOverride?: () => void;
  getNote?: () => string | null;
}

/**
 * A complete `SettingDef` whose display, edit, parse and step forms are all
 * derived from the one spec — which is what makes them unable to disagree.
 */
export function numberSetting(opts: NumberSettingOpts): SettingDef {
  const { spec } = opts;
  return {
    id: opts.id,
    label: opts.label,
    type: "number",
    getValue: () => formatNumber(spec, opts.read()),
    getEditValue: () => editNumber(spec, opts.read()),
    rangeHint: () => rangeHint(spec),
    onStep: (delta) => opts.write(stepNumber(spec, opts.read(), delta)),
    onTextCommit: (v) => {
      const bad = validateNumber(spec, v);
      if (bad) return bad;
      opts.write(parseNumber(spec, v, opts.read()));
      return null;
    },
    ...(opts.describe ? { describe: opts.describe } : {}),
    ...(opts.getScope ? { getScope: opts.getScope } : {}),
    ...(opts.onClearOverride ? { onClearOverride: opts.onClearOverride } : {}),
    ...(opts.getNote ? { getNote: opts.getNote } : {}),
  };
}
