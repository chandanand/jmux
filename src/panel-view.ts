import type { IssueStateType } from "./adapters/types";
import type { WorkStage } from "./repo-settings";

/**
 * Which items a view shows. `scope` picks the data source; everything else
 * narrows it, which is what turns a generic "my issues" tab into a named pull
 * queue ("QA Failed", "Release Blockers").
 *
 * `states` is precise but workspace-specific; `stages` says the same kind of
 * thing in tracker-agnostic terms, so shipped defaults can use it and still
 * mean something in any workspace.
 */
export interface PanelViewFilter {
  scope: "assigned" | "authored" | "reviewing";
  /** Raw tracker state names, matched case-insensitively. */
  states?: string[];
  /** Lifecycle stages, resolved through the per-repo projection. */
  stages?: WorkStage[];
  /** Issue label names, matched case-insensitively; any match passes. */
  labels?: string[];
  /** Keep issues at least this urgent (Linear: 1=urgent … 4=low; 0=none). */
  priorityAtMost?: number;
}

/**
 * Urgency rank for sorting/thresholding. Linear encodes "no priority" as 0
 * even though it is the *least* urgent value, so it has to be pushed to the
 * bottom explicitly — a plain numeric compare ranks unprioritised issues
 * above urgent ones.
 */
function urgency(priority: number | undefined): number {
  if (priority === undefined || priority === 0) return Number.POSITIVE_INFINITY;
  return priority;
}

function matchesAnyName(
  values: Array<{ name: string }> | undefined,
  wanted: string[],
): boolean {
  const set = new Set(wanted.map((w) => w.trim().toLowerCase()));
  return (values ?? []).some((v) => set.has(v.name.trim().toLowerCase()));
}

/**
 * Whether an issue passes a view's filter. Criteria combine with AND; the
 * values within one criterion combine with OR. An absent criterion never
 * filters, so `{ scope }` alone keeps today's behaviour exactly.
 */
export function matchesIssueFilter(
  issue: { status: string; labels?: Array<{ name: string }>; priority?: number },
  filter: PanelViewFilter,
  stageOf: (issue: { status: string }) => WorkStage,
): boolean {
  if (filter.states && filter.states.length > 0) {
    const wanted = new Set(filter.states.map((s) => s.trim().toLowerCase()));
    if (!wanted.has((issue.status ?? "").trim().toLowerCase())) return false;
  }
  if (filter.stages && filter.stages.length > 0) {
    if (!filter.stages.includes(stageOf(issue))) return false;
  }
  if (filter.labels && filter.labels.length > 0) {
    if (!matchesAnyName(issue.labels, filter.labels)) return false;
  }
  if (filter.priorityAtMost !== undefined) {
    if (urgency(issue.priority) > filter.priorityAtMost) return false;
  }
  return true;
}

/**
 * The filter that actually governs membership.
 *
 * `sections` and `filter.states` are two ways of saying "these statuses belong
 * here", and a view carrying both used to apply them as an AND — so a states
 * filter set from the panel's `F` menu silently hid issues its section claimed.
 * Sections win, per the settled model: they are the unit of classification and
 * the only one that also carries meaning. Every other axis (labels, priority,
 * stages) narrows a sectioned view as normal.
 */
export function effectiveFilter(view: PanelView): PanelViewFilter {
  if (!view.sections?.length || view.filter.states === undefined) return view.filter;
  const { states, ...rest } = view.filter;
  return rest;
}

/**
 * A section: an ordered bucket of statuses inside a tab, and the header they
 * render under in the panel. Nothing more — a section carries no behaviour.
 *
 * It used to carry a `stage`, so classifying a status meant choosing between
 * four values of which only one (`parked`) did anything observable. That made
 * every status a four-way decision with a 3-in-4 chance of being a no-op. The
 * decision that actually matters — does this work leave my sidebar — is now one
 * column in the workflow screen's status table (`pipeline.parkedStates`), and
 * idea/active/done come from the tracker's own categories with nothing to
 * configure.
 */
export interface PanelViewSection {
  label: string;
  states: string[];
}

export type GroupByField = "team" | "project" | "status" | "priority" | "none";
export type SortByField = "priority" | "updated" | "created" | "status";

export interface PanelView {
  id: string;
  label: string;
  source: "issues" | "mrs";
  filter: PanelViewFilter;
  groupBy: GroupByField;
  subGroupBy: GroupByField;
  sortBy: SortByField;
  sortOrder: "asc" | "desc";
  sessionLinkedFirst: boolean;
  /**
   * Explicit ordered sections. When present these drive BOTH membership (the
   * union of every group's states) and the headers, and `groupBy` /
   * `filter.states` are ignored for this view.
   */
  sections?: PanelViewSection[];
}

/**
 * Index of the first group claiming `status`, or -1 if none does.
 * Case- and whitespace-insensitive, matching every other state comparison.
 */
export function sectionIndexForStatus(
  status: string,
  sections: PanelViewSection[] | undefined,
): number {
  if (!sections) return -1;
  const want = (status ?? "").trim().toLowerCase();
  for (let i = 0; i < sections.length; i++) {
    if (sections[i]!.states.some((s) => s.trim().toLowerCase() === want)) return i;
  }
  return -1;
}

/**
 * Read a view's section list, dropping entries that can't render or match.
 *
 * That includes sections holding no statuses: a section is *defined by* the
 * statuses it covers, so an empty one is a header that can never claim an issue
 * — invisible dead config the editor gives you no way to see or remove. Live
 * edits prune the same case through `pruneEmptySections`; this catches the ones
 * already written to disk.
 */
function parseSections(raw: unknown): PanelViewSection[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PanelViewSection[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { label, states } = entry as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim()) continue;
    if (!Array.isArray(states) || !states.every((s) => typeof s === "string")) continue;
    if (states.length === 0) continue;
    out.push({ label, states: states as string[] });
  }
  return out.length > 0 ? out : undefined;
}

const VALID_COMBOS: Array<{ source: string; scope: string }> = [
  { source: "issues", scope: "assigned" },
  { source: "mrs", scope: "authored" },
  { source: "mrs", scope: "reviewing" },
];

export const DEFAULT_VIEWS: PanelView[] = [
  {
    id: "my-issues", label: "Issues", source: "issues",
    filter: { scope: "assigned" },
    groupBy: "team", subGroupBy: "status",
    sortBy: "priority", sortOrder: "asc", sessionLinkedFirst: true,
  },
  {
    id: "my-mrs", label: "My MRs", source: "mrs",
    filter: { scope: "authored" },
    groupBy: "none", subGroupBy: "none",
    sortBy: "updated", sortOrder: "desc", sessionLinkedFirst: true,
  },
  {
    id: "review", label: "Review", source: "mrs",
    filter: { scope: "reviewing" },
    groupBy: "none", subGroupBy: "none",
    sortBy: "created", sortOrder: "asc", sessionLinkedFirst: false,
  },
];

export function parseViews(raw: unknown): PanelView[] {
  if (!Array.isArray(raw)) return DEFAULT_VIEWS;
  const views: PanelView[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label, source, filter, groupBy, subGroupBy, sortBy, sortOrder, sessionLinkedFirst } = entry as any;
    if (typeof id !== "string" || !id) continue;
    if (typeof label !== "string" || !label) continue;
    if (source !== "issues" && source !== "mrs") continue;
    const scope = filter?.scope;
    if (!VALID_COMBOS.some((c) => c.source === source && c.scope === scope)) {
      process.stderr.write(`jmux: invalid panelView "${id}" — ${source}+${scope} is not a valid combination\n`);
      continue;
    }
    views.push({
      id, label, source,
      filter: { scope, ...parseFilterExtras(filter) },
      groupBy: isGroupByField(groupBy) ? groupBy : "none",
      subGroupBy: isGroupByField(subGroupBy) ? subGroupBy : "none",
      sortBy: isSortByField(sortBy) ? sortBy : "priority",
      sortOrder: sortOrder === "desc" ? "desc" : "asc",
      sessionLinkedFirst: sessionLinkedFirst !== false,
      ...(parseSections((entry as any).sections) ? { sections: parseSections((entry as any).sections)! } : {}),
    });
  }
  return views.length > 0 ? views : DEFAULT_VIEWS;
}

const STAGES: readonly WorkStage[] = ["idea", "active", "parked", "done"];

/**
 * Read the optional narrowing axes off a raw filter object. Malformed entries
 * are dropped individually rather than rejecting the whole view — losing one
 * bad label list is better than losing the user's whole tab.
 */
function parseFilterExtras(raw: unknown): Partial<PanelViewFilter> {
  const f = raw as Record<string, unknown> | undefined;
  const out: Partial<PanelViewFilter> = {};
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string") && v.length > 0
      ? (v as string[])
      : undefined;

  const states = strings(f?.states);
  if (states) out.states = states;
  const labels = strings(f?.labels);
  if (labels) out.labels = labels;
  const stages = strings(f?.stages)?.filter((s): s is WorkStage => STAGES.includes(s as WorkStage));
  if (stages && stages.length > 0) out.stages = stages;
  if (typeof f?.priorityAtMost === "number" && Number.isFinite(f.priorityAtMost)) {
    out.priorityAtMost = f.priorityAtMost;
  }
  return out;
}

function isGroupByField(v: unknown): v is GroupByField {
  return v === "team" || v === "project" || v === "status" || v === "priority" || v === "none";
}

function isSortByField(v: unknown): v is SortByField {
  return v === "priority" || v === "updated" || v === "created" || v === "status";
}

const GROUP_BY_CYCLE: GroupByField[] = ["team", "project", "status", "priority", "none"];
const SORT_BY_CYCLE: SortByField[] = ["priority", "updated", "created", "status"];

export function cycleGroupBy(current: GroupByField): GroupByField {
  const idx = GROUP_BY_CYCLE.indexOf(current);
  return GROUP_BY_CYCLE[(idx + 1) % GROUP_BY_CYCLE.length];
}

export function cycleSortBy(current: SortByField): SortByField {
  const idx = SORT_BY_CYCLE.indexOf(current);
  return SORT_BY_CYCLE[(idx + 1) % SORT_BY_CYCLE.length];
}

export function toggleSortOrder(current: "asc" | "desc"): "asc" | "desc" {
  return current === "asc" ? "desc" : "asc";
}

/**
 * The single next thing to work on: the first item of the first non-empty
 * queue, in the user's configured queue order.
 *
 * Taking view *ids* rather than filters keeps queues defined once, in
 * `panelViews`. Adding a queue to the rotation is then an ordering change, not
 * a second copy of its filter that can drift from the tab it mirrors.
 */
export function pickUpNext<T>(
  order: string[],
  itemsByView: Map<string, T[]>,
): { viewId: string; item: T } | null {
  for (const viewId of order) {
    const items = itemsByView.get(viewId);
    if (items && items.length > 0) return { viewId, item: items[0]! };
  }
  return null;
}

/**
 * Apply a patch to a view's filter, dropping emptied axes.
 *
 * Emptied lists must be *removed*, not left as `[]`: `parseViews` discards
 * empty arrays on load, so keeping one would make the in-memory view disagree
 * with the same config after a restart.
 */
export function applyFilterPatch(
  filter: PanelViewFilter,
  patch: Partial<PanelViewFilter>,
): PanelViewFilter {
  const next: PanelViewFilter = { ...filter, ...patch };
  for (const key of ["states", "stages", "labels"] as const) {
    const v = next[key];
    if (Array.isArray(v) && v.length === 0) delete next[key];
  }
  if (next.priorityAtMost === undefined) delete next.priorityAtMost;
  return next;
}

/** Toggle one value in a list-valued filter axis, case-insensitively. */
export function toggleFilterValue(
  filter: PanelViewFilter,
  key: "states" | "stages" | "labels",
  value: string,
): PanelViewFilter {
  const current = ((filter[key] as string[] | undefined) ?? []).slice();
  const at = current.findIndex((n) => n.toLowerCase() === value.toLowerCase());
  if (at >= 0) current.splice(at, 1);
  else current.push(value);
  return applyFilterPatch(filter, { [key]: current } as Partial<PanelViewFilter>);
}

/** Where one tracker state currently rolls up to. */
export interface StateAssignment {
  state: string;
  viewId: string;
  viewLabel: string;
  sectionLabel: string;
}

/**
 * The inverse of the config shape: one row per assigned state saying which tab
 * and section it feeds. The stored model is tab → sections → states because that is
 * what rendering needs; this is what a human asks for.
 */
export function stateAssignments(views: PanelView[]): StateAssignment[] {
  const out: StateAssignment[] = [];
  for (const view of views) {
    for (const group of view.sections ?? []) {
      for (const state of group.states) {
        out.push({ state, viewId: view.id, viewLabel: view.label, sectionLabel: group.label });
      }
    }
  }
  return out;
}

function withoutState(views: PanelView[], state: string): PanelView[] {
  const want = state.trim().toLowerCase();
  return views.map((view) => view.sections
    ? {
        ...view,
        sections: view.sections.map((g) => ({
          ...g,
          states: g.states.filter((s) => s.trim().toLowerCase() !== want),
        })),
      }
    : view);
}

/**
 * Move a state into one tab's group, removing it from anywhere else first.
 *
 * Enforcing one home per state is what keeps the model comprehensible: a status
 * appearing under two tabs would silently resolve via `sectionIndexForStatus`'s
 * first-wins tie-break, which is a safety net, not a feature. Returns the input
 * unchanged when the target doesn't exist.
 */
export function assignStateToGroup(
  views: PanelView[],
  state: string,
  viewId: string,
  sectionLabel: string,
): PanelView[] {
  const target = views.find((v) => v.id === viewId);
  if (!target?.sections?.some((g) => g.label === sectionLabel)) return views;

  return withoutState(views, state).map((view) => view.id !== viewId
    ? view
    : {
        ...view,
        sections: view.sections!.map((g) => g.label === sectionLabel
          ? { ...g, states: [...g.states, state] }
          : g),
      });
}

/** Remove a state from every tab, so it stops appearing in any queue. */
export function unassignState(views: PanelView[], state: string): PanelView[] {
  return withoutState(views, state);
}

// --- Queue CRUD ---
//
// All pure and non-mutating: the caller swaps in the returned array and
// persists it. Every operation that can't be satisfied (blank label, duplicate
// group, unknown target) returns the input unchanged rather than throwing, so
// a menu can call these blind and simply see nothing happen.

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Append a new grouped issues tab. Ids are slugged and de-duplicated. */
export function createView(views: PanelView[], label: string): PanelView[] {
  const trimmed = label.trim();
  if (!trimmed) return views;
  const base = slugify(trimmed) || "queue";
  let id = base;
  for (let n = 2; views.some((v) => v.id === id); n++) id = `${base}-${n}`;
  return [...views, {
    id, label: trimmed, source: "issues",
    filter: { scope: "assigned" },
    groupBy: "none", subGroupBy: "none",
    sortBy: "priority", sortOrder: "asc", sessionLinkedFirst: false,
    sections: [],
  }];
}

export function renameView(views: PanelView[], viewId: string, label: string): PanelView[] {
  const trimmed = label.trim();
  if (!trimmed) return views;
  return views.map((v) => (v.id === viewId ? { ...v, label: trimmed } : v));
}

/** Move a tab by `delta` positions, clamped at both ends. */
export function moveView(views: PanelView[], viewId: string, delta: number): PanelView[] {
  const from = views.findIndex((v) => v.id === viewId);
  if (from < 0) return views;
  const to = Math.max(0, Math.min(views.length - 1, from + delta));
  if (to === from) return views;
  const next = [...views];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function deleteView(views: PanelView[], viewId: string): PanelView[] {
  return views.filter((v) => v.id !== viewId);
}

function mapSections(
  views: PanelView[],
  viewId: string,
  fn: (sections: PanelViewSection[]) => PanelViewSection[] | null,
): PanelView[] {
  const view = views.find((v) => v.id === viewId);
  if (!view) return views;
  const next = fn(view.sections ?? []);
  if (next === null) return views;
  return views.map((v) => (v.id === viewId ? { ...v, sections: next } : v));
}

const hasLabel = (sections: PanelViewSection[], label: string): boolean =>
  sections.some((g) => g.label.trim().toLowerCase() === label.trim().toLowerCase());

export function createSection(views: PanelView[], viewId: string, label: string): PanelView[] {
  const trimmed = label.trim();
  if (!trimmed) return views;
  return mapSections(views, viewId, (sections) =>
    // Labels key both the render node and the collapse set, so duplicates
    // within a tab would alias each other.
    hasLabel(sections, trimmed) ? null : [...sections, { label: trimmed, states: [] }]);
}

export function renameSection(
  views: PanelView[], viewId: string, from: string, to: string,
): PanelView[] {
  const trimmed = to.trim();
  if (!trimmed) return views;
  return mapSections(views, viewId, (sections) => {
    if (hasLabel(sections, trimmed)) return null;
    if (!hasLabel(sections, from)) return null;
    return sections.map((g) => (g.label === from ? { ...g, label: trimmed } : g));
  });
}

export function moveSection(
  views: PanelView[], viewId: string, label: string, delta: number,
): PanelView[] {
  return mapSections(views, viewId, (sections) => {
    const from = sections.findIndex((g) => g.label === label);
    if (from < 0) return null;
    const to = Math.max(0, Math.min(sections.length - 1, from + delta));
    if (to === from) return null;
    const next = [...sections];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    return next;
  });
}

export function deleteSection(views: PanelView[], viewId: string, label: string): PanelView[] {
  return mapSections(views, viewId, (sections) => sections.filter((g) => g.label !== label));
}

/**
 * Drop sections left holding no statuses.
 *
 * A section is *defined by* the statuses it covers, so one with none can never
 * match an issue — it is a header that renders forever and classifies nothing.
 * Moving a status out of a single-status section empties it, so every
 * assignment path runs through here rather than each remembering to tidy up.
 *
 * This is not the "empty section keeps its header" rule, which is about a
 * section with statuses but no *issues* right now — that one still renders,
 * because "nothing is blocked" is information.
 */
export function pruneEmptySections(views: PanelView[]): PanelView[] {
  return views.map((view) => {
    if (!view.sections) return view;
    const kept = view.sections.filter((s) => s.states.length > 0);
    return kept.length === view.sections.length ? view : { ...view, sections: kept };
  });
}

/**
 * A starting layout for a workspace nobody has configured yet, built from the
 * tracker's own stable categories rather than from status names — which vary
 * per workspace and are exactly what a new user has no opinion about yet.
 *
 * One section per status, labelled with the status, because that is the shape
 * the editor produces by hand: a seeded config and a hand-built one are then
 * indistinguishable, and there is nothing to un-learn.
 *
 * No suggested tab parks. Parking removes sessions from the sidebar, so it
 * stays a decision the user makes deliberately — the same reason
 * `stageFromStateType` never yields `parked` either.
 */
const SUGGESTED_TABS: ReadonlyArray<{ label: string; types: IssueStateType[] }> = [
  { label: "To do", types: ["triage", "backlog"] },
  { label: "In progress", types: ["unstarted", "started"] },
  { label: "Done", types: ["completed", "canceled", "duplicate"] },
];

export function suggestLayout(
  states: ReadonlyArray<{ name: string; type: IssueStateType }>,
  existing: PanelView[] = [],
): PanelView[] {
  // listWorkflowStates() unions every team, so the same status name recurs.
  const seen = new Set<string>();
  const unique = states.filter((s) => {
    const key = s.name.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Appended to what is already there, never substituted for it: the tab list
  // also holds the user's MR tabs, and a suggestion that quietly deleted them
  // would be the worst kind of first-run surprise. Building on `existing` also
  // routes id generation through createView's de-duplication.
  let views: PanelView[] = existing;
  for (const tab of SUGGESTED_TABS) {
    const mine = unique.filter((s) => tab.types.includes(s.type));
    if (mine.length === 0) continue;
    const sections: PanelViewSection[] = mine.map((s) => ({ label: s.name, states: [s.name] }));
    views = createView(views, tab.label)
      .map((v, i, arr) => (i === arr.length - 1 ? { ...v, sections } : v));
  }
  return views;
}

/**
 * Statuses whose sessions park, as a `WorkStage` map.
 *
 * Only `parked` is ever populated. The other three stages need no configuration
 * at all: `projectStage` falls through to the tracker's own category for any
 * status not listed here, and triage/backlog → idea, unstarted/started →
 * active, completed/canceled → done is already the right answer everywhere.
 * Asking a user to restate it was 25 decisions that changed nothing.
 *
 * The list is flat and keyed on the status name rather than derived from tab
 * membership, because the two are orthogonal facts — a status can be work
 * someone else has whether or not you show it in a tab. They were derived from
 * each other once, to stop two settings drifting apart; the table that displays
 * them side by side in adjacent columns is what makes that unnecessary.
 */
export function parkedStages(parkedStates: readonly string[]): Record<WorkStage, string[]> {
  return { idea: [], active: [], parked: [...parkedStates], done: [] };
}

/** Add or remove a status from the parked list, case-insensitively. */
export function toggleParkedState(parked: readonly string[], state: string): string[] {
  const at = parked.findIndex((s) => s.trim().toLowerCase() === state.trim().toLowerCase());
  if (at < 0) return [...parked, state];
  const next = [...parked];
  next.splice(at, 1);
  return next;
}

export function isParkedState(parked: readonly string[], state: string): boolean {
  return parked.some((s) => s.trim().toLowerCase() === state.trim().toLowerCase());
}
