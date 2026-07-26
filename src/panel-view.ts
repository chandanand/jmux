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
 * One named section within a tab, listing the tracker statuses that roll up
 * into it. Order within a view is priority order, and an issue lands in the
 * first group that claims its status.
 *
 * This is what makes tab *names* static while their *membership* stays
 * per-workspace configurable: jmux ships the tabs, you map your own statuses in.
 */
export interface PanelViewGroup {
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
  groups?: PanelViewGroup[];
}

/**
 * Index of the first group claiming `status`, or -1 if none does.
 * Case- and whitespace-insensitive, matching every other state comparison.
 */
export function groupIndexForStatus(
  status: string,
  groups: PanelViewGroup[] | undefined,
): number {
  if (!groups) return -1;
  const want = (status ?? "").trim().toLowerCase();
  for (let i = 0; i < groups.length; i++) {
    if (groups[i]!.states.some((s) => s.trim().toLowerCase() === want)) return i;
  }
  return -1;
}

/** Read a view's group list, dropping entries that can't render or match. */
function parseGroups(raw: unknown): PanelViewGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PanelViewGroup[] = [];
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
      ...(parseGroups((entry as any).groups) ? { groups: parseGroups((entry as any).groups)! } : {}),
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
  groupLabel: string;
}

/**
 * The inverse of the config shape: one row per assigned state saying which tab
 * and group it feeds. The stored model is tab → groups → states because that is
 * what rendering needs; this is what a human asks for.
 */
export function stateAssignments(views: PanelView[]): StateAssignment[] {
  const out: StateAssignment[] = [];
  for (const view of views) {
    for (const group of view.groups ?? []) {
      for (const state of group.states) {
        out.push({ state, viewId: view.id, viewLabel: view.label, groupLabel: group.label });
      }
    }
  }
  return out;
}

function withoutState(views: PanelView[], state: string): PanelView[] {
  const want = state.trim().toLowerCase();
  return views.map((view) => view.groups
    ? {
        ...view,
        groups: view.groups.map((g) => ({
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
 * appearing under two tabs would silently resolve via `groupIndexForStatus`'s
 * first-wins tie-break, which is a safety net, not a feature. Returns the input
 * unchanged when the target doesn't exist.
 */
export function assignStateToGroup(
  views: PanelView[],
  state: string,
  viewId: string,
  groupLabel: string,
): PanelView[] {
  const target = views.find((v) => v.id === viewId);
  if (!target?.groups?.some((g) => g.label === groupLabel)) return views;

  return withoutState(views, state).map((view) => view.id !== viewId
    ? view
    : {
        ...view,
        groups: view.groups!.map((g) => g.label === groupLabel
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
    groups: [],
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

function mapGroups(
  views: PanelView[],
  viewId: string,
  fn: (groups: PanelViewGroup[]) => PanelViewGroup[] | null,
): PanelView[] {
  const view = views.find((v) => v.id === viewId);
  if (!view) return views;
  const next = fn(view.groups ?? []);
  if (next === null) return views;
  return views.map((v) => (v.id === viewId ? { ...v, groups: next } : v));
}

const hasLabel = (groups: PanelViewGroup[], label: string): boolean =>
  groups.some((g) => g.label.trim().toLowerCase() === label.trim().toLowerCase());

export function createGroup(views: PanelView[], viewId: string, label: string): PanelView[] {
  const trimmed = label.trim();
  if (!trimmed) return views;
  return mapGroups(views, viewId, (groups) =>
    // Labels key both the render node and the collapse set, so duplicates
    // within a tab would alias each other.
    hasLabel(groups, trimmed) ? null : [...groups, { label: trimmed, states: [] }]);
}

export function renameGroup(
  views: PanelView[], viewId: string, from: string, to: string,
): PanelView[] {
  const trimmed = to.trim();
  if (!trimmed) return views;
  return mapGroups(views, viewId, (groups) => {
    if (hasLabel(groups, trimmed)) return null;
    if (!hasLabel(groups, from)) return null;
    return groups.map((g) => (g.label === from ? { ...g, label: trimmed } : g));
  });
}

export function moveGroup(
  views: PanelView[], viewId: string, label: string, delta: number,
): PanelView[] {
  return mapGroups(views, viewId, (groups) => {
    const from = groups.findIndex((g) => g.label === label);
    if (from < 0) return null;
    const to = Math.max(0, Math.min(groups.length - 1, from + delta));
    if (to === from) return null;
    const next = [...groups];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    return next;
  });
}

export function deleteGroup(views: PanelView[], viewId: string, label: string): PanelView[] {
  return mapGroups(views, viewId, (groups) => groups.filter((g) => g.label !== label));
}
