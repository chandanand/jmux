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
