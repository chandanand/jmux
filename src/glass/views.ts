// Command Center "views" — named presets of the sidebar's own axes (filter,
// groupBy, sortBy). Membership is no longer a hand-assigned tab; it is
// whatever `orderSessions` produces for a view's axes. This module is the
// pure logic: parsing/validation/CRUD plus the three transitions that decide
// which view is active and what the live (possibly dirty) axes are. Nothing
// here touches tmux or config I/O — see config.ts for the migration that
// seeds/persists this shape, and main.ts (phase 6) for wiring.
//
// Was deliberately parallel to glass/tabs.ts rather than a refactor of it —
// duplication was correct, not laziness, because the two modules answered
// different questions (a hand-assigned registry vs. derived membership) right
// up until main.ts and cli/cc.ts moved off tabs.ts, at which point it (and
// glass/reload.ts, its hot-reload clamp) were deleted outright.

import type { FilterMode, GroupMode, SortMode } from "../sidebar-sort";
import { FILTER_MODES, GROUP_MODES, SORT_MODES } from "../sidebar-sort";

export interface CommandCenterAxes {
  filter: FilterMode;
  groupBy: GroupMode;
  sortBy: SortMode;
}

export interface CommandCenterView extends CommandCenterAxes {
  id: string;
  name: string;
}

// The grid does not seed from the sidebar's own default (`filter: "all"`,
// sidebar.ts:992) — "all" on a 25-session machine is 25 mirrors on first
// open. This seed *is* the first-run state, and every axis clamp below falls
// back to it.
export const DEFAULT_VIEW_SEED_ID = "active";
export const DEFAULT_VIEW_SEED_NAME = "Active";

function seedView(): CommandCenterView {
  return {
    id: DEFAULT_VIEW_SEED_ID,
    name: DEFAULT_VIEW_SEED_NAME,
    filter: "active",
    groupBy: "status",
    sortBy: "status",
  };
}

function seedViews(): CommandCenterView[] {
  return [seedView()];
}

/** Project just the axes off a view (or off anything shaped like one). */
export function axesOf(view: CommandCenterAxes): CommandCenterAxes {
  return { filter: view.filter, groupBy: view.groupBy, sortBy: view.sortBy };
}

export function axesDiffer(a: CommandCenterAxes, b: CommandCenterAxes): boolean {
  return a.filter !== b.filter || a.groupBy !== b.groupBy || a.sortBy !== b.sortBy;
}

function clampAxis<T>(value: unknown, legal: readonly T[], fallback: T): T {
  return (legal as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

const MAX_VIEW_NAME = 24;

/**
 * The shape `slugifyViewName` produces: lowercase alphanumerics, hyphen
 * separated, no leading/trailing/doubled hyphen. `normalizeViews` enforces
 * this on every hand-edited or hot-reloaded id — not because an id has to be
 * *derived from* its name, only shaped like one — so a config that never went
 * through the CRUD path can't smuggle in something `slugifyViewName` itself
 * would never produce (spaces, punctuation, empty).
 */
const SLUG_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Parse/validate/synthesize the view registry. Always returns a non-empty
 * array. Malformed entries are dropped — the defensive shape the tab registry
 * this replaced used to have — rather than repaired, on the same reasoning
 * `normalizeTabs` used: a config that can't be trusted to round-trip a name
 * shouldn't be trusted to round-trip a truncation of it either.
 *
 * Enforces every invariant the interactive CRUD path (`addView`/`renameView`
 * via `validateViewName`/`slugifyViewName`) already promises, because
 * `config.json` is hand-editable and hot-reloaded — nothing routes a
 * malformed entry through CRUD first:
 *
 * - `id` must look like a slug (`SLUG_ID_RE`) and be unique.
 * - `name` must be non-empty after trimming and at most `MAX_VIEW_NAME`
 *   characters, unique **case-insensitively** — `validateViewName`'s own
 *   uniqueness rule — and is stored trimmed.
 * - Each axis is clamped to its legal enum, falling back to the seed's value:
 *   a hand-edited or stale config axis must never propagate an illegal mode
 *   into `orderSessions`.
 */
export function normalizeViews(raw: unknown): CommandCenterView[] {
  if (!Array.isArray(raw)) return seedViews();
  const seed = seedView();
  const out: CommandCenterView[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    const rawName = (entry as { name?: unknown }).name;
    if (typeof id !== "string" || !SLUG_ID_RE.test(id)) continue;
    if (typeof rawName !== "string") continue;
    const name = rawName.trim();
    if (name.length === 0 || name.length > MAX_VIEW_NAME) continue;
    if (seenIds.has(id)) continue;
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenIds.add(id);
    seenNames.add(nameKey);
    out.push({
      id,
      name,
      filter: clampAxis((entry as { filter?: unknown }).filter, FILTER_MODES, seed.filter),
      groupBy: clampAxis((entry as { groupBy?: unknown }).groupBy, GROUP_MODES, seed.groupBy),
      sortBy: clampAxis((entry as { sortBy?: unknown }).sortBy, SORT_MODES, seed.sortBy),
    });
  }
  return out.length > 0 ? out : seedViews();
}

/**
 * Clamp a persisted/live axes struct against a fallback (the active view's
 * own axes) rather than the seed — an invalid live axis should fall back to
 * what the active view already means, not silently reset to "Active".
 */
export function normalizeAxes(raw: unknown, fallback: CommandCenterAxes): CommandCenterAxes {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<CommandCenterAxes>;
  return {
    filter: clampAxis(r.filter, FILTER_MODES, fallback.filter),
    groupBy: clampAxis(r.groupBy, GROUP_MODES, fallback.groupBy),
    sortBy: clampAxis(r.sortBy, SORT_MODES, fallback.sortBy),
  };
}

/**
 * Resolve a raw `commandCenterActiveViewId` to a view id. A value naming a
 * known view resolves to that view; everything else (unknown id, missing,
 * malformed) folds to the first view — there is no protected default id to
 * fall back to instead, unlike tabs.
 */
export function resolveActiveViewId(
  rawId: string | null | undefined,
  views: CommandCenterView[],
): string {
  if (rawId && views.some((v) => v.id === rawId)) return rawId;
  return views[0].id;
}

/** Build a stable, unique slug id from a display name. */
export function slugifyViewName(name: string, existingIds: Iterable<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "view";
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export type ViewValidation = { ok: true; name: string } | { ok: false; error: string };

export function validateViewName(
  name: string,
  views: CommandCenterView[],
  opts?: { excludeId?: string },
): ViewValidation {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, error: "View name cannot be empty" };
  if (trimmed.length > MAX_VIEW_NAME) return { ok: false, error: "View name too long (max 24)" };
  const lower = trimmed.toLowerCase();
  for (const v of views) {
    if (opts?.excludeId && v.id === opts.excludeId) continue;
    if (v.name.toLowerCase() === lower) {
      return { ok: false, error: `A view named "${trimmed}" already exists` };
    }
  }
  return { ok: true, name: trimmed };
}

export type ViewMutation = { ok: true; views: CommandCenterView[] } | { ok: false; error: string };

/** Save the current (live) axes as a new named view — "Save current axes as view…". */
export function addView(
  views: CommandCenterView[],
  name: string,
  axes: CommandCenterAxes,
): ViewMutation {
  const v = validateViewName(name, views);
  if (!v.ok) return v;
  const id = slugifyViewName(v.name, views.map((view) => view.id));
  return { ok: true, views: [...views, { id, name: v.name, ...axes }] };
}

export function renameView(views: CommandCenterView[], id: string, newName: string): ViewMutation {
  if (!views.some((v) => v.id === id)) return { ok: false, error: "Unknown view" };
  const v = validateViewName(newName, views, { excludeId: id });
  if (!v.ok) return v;
  return { ok: true, views: views.map((view) => (view.id === id ? { ...view, name: v.name } : view)) };
}

/** The result shape shared by all three transitions: a registry plus which
 * view is active and what the live axes now are. */
export interface ViewSelection {
  views: CommandCenterView[];
  activeViewId: string;
  axes: CommandCenterAxes;
}

/**
 * Transition 1 — switching views while the axes are dirty: the incoming
 * view's axes win and the dirty axes are discarded. Selecting a view means
 * adopting it; carrying unsaved axes across would make the marker mean two
 * different things. An unknown id is a no-op (folds back to whatever is
 * currently active), the defensive posture the tab registry this replaced
 * used to take.
 */
export function switchView(
  views: CommandCenterView[],
  activeViewId: string,
  id: string,
): ViewSelection {
  const target = views.find((v) => v.id === id);
  if (!target) {
    const current = views.find((v) => v.id === activeViewId) ?? views[0];
    return { views, activeViewId: current.id, axes: axesOf(current) };
  }
  return { views, activeViewId: target.id, axes: axesOf(target) };
}

/**
 * Transition 2 — deleting the active view: the previous view by index becomes
 * active, or the first when it was index 0; its axes are adopted. Deleting
 * the last remaining view re-seeds the default and adopts it. There is no
 * protected default (unlike `deleteTab`) — a view has no members to strand,
 * so deletion never fails. Deleting a view that isn't active leaves the
 * current selection untouched.
 */
export function deleteView(
  views: CommandCenterView[],
  activeViewId: string,
  id: string,
): ViewSelection {
  const idx = views.findIndex((v) => v.id === id);
  if (idx < 0) {
    const current = views.find((v) => v.id === activeViewId) ?? views[0];
    return { views, activeViewId: current.id, axes: axesOf(current) };
  }

  const remaining = views.filter((v) => v.id !== id);

  if (id !== activeViewId) {
    const current = views.find((v) => v.id === activeViewId)!;
    return { views: remaining, activeViewId, axes: axesOf(current) };
  }

  if (remaining.length === 0) {
    const seeded = seedViews();
    return { views: seeded, activeViewId: seeded[0].id, axes: axesOf(seeded[0]) };
  }

  const nextIdx = idx === 0 ? 0 : idx - 1;
  const next = remaining[nextIdx];
  return { views: remaining, activeViewId: next.id, axes: axesOf(next) };
}

/**
 * Transition 3 — hot reload changing the active view: re-normalize and clamp
 * the active id. If the id survives, it stays active and axes that were dirty
 * stay dirty (the user's in-flight narrowing is not the file's business). If
 * it vanished, fall to index 0 and adopt its axes.
 */
export function reloadViews(
  raw: unknown,
  activeViewId: string,
  axes: CommandCenterAxes,
): ViewSelection {
  const views = normalizeViews(raw);
  if (views.some((v) => v.id === activeViewId)) {
    return { views, activeViewId, axes };
  }
  const fallback = views[0];
  return { views, activeViewId: fallback.id, axes: axesOf(fallback) };
}
