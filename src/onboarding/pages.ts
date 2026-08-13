import type { SetupStatus, StepId } from "./status";

/**
 * The page table.
 *
 * Intent is in-memory flow state and is deliberately never persisted. A stored
 * route is a second source of truth that can disagree with what is actually
 * configured — and `config.ts` casts its parsed document rather than validating
 * it, so a union would buy nothing against a hand-edited file. On re-entry the
 * map derives what is in play from what is true.
 */
export type Intent = "solo" | "tracker" | "manual";

export type PageId =
  | "welcome" | "projects" | "agents"
  | "tracker" | "team" | "workflow" | "done";

export interface IntentChoice {
  id: Intent;
  label: string;
  /** Stated before the commitment — the cheapest thing a wizard can do. */
  cost: string;
  blurb: string;
}

/**
 * The three answers, in the order they are offered.
 *
 * The third exists so that "none of this" is a first-class answer given in the
 * flow's own vocabulary, rather than an Escape that reads as a failure.
 */
export const INTENT_CHOICES: readonly IntentChoice[] = [
  {
    id: "solo",
    label: "Just run agents",
    cost: "2 steps, about a minute",
    blurb: "Somewhere to work, and agent status in the sidebar.",
  },
  {
    id: "tracker",
    label: "Agents, wired to my issue tracker",
    cost: "5 steps",
    blurb: "All of the above, plus start work straight from a ticket.",
  },
  {
    id: "manual",
    label: "I'll do it myself",
    cost: "",
    blurb: "Skip all of this. Nothing configured, nothing claimed.",
  },
];

export interface PageDef {
  id: PageId;
  title: string;
  /** The step this page satisfies, when it has one. */
  step?: StepId;
  /**
   * Whether this page is numbered in `Step N of M`.
   *
   * Welcome and Done are not steps: counting them would make a two-step promise
   * read as four and put the finish line further away than it is.
   */
  counts: boolean;
  /** Paragraphs. Wrapped to the measure by the renderer, not here. */
  body: (status: SetupStatus) => string[];
}

const SOLO_STEPS: PageId[] = ["projects", "agents"];
const TRACKER_STEPS: PageId[] = ["projects", "agents", "tracker", "team", "workflow"];

export const PAGES: Record<PageId, PageDef> = {
  welcome: {
    id: "welcome",
    title: "jmux",
    counts: false,
    body: () => [
      "Run several coding agents at once, and see what they're all doing.",
      "Every piece of work gets its own tmux session, its own worktree and its own agent. The sidebar on your left is the answer to “who needs me?”.",
      "What do you want to set up?",
    ],
  },

  projects: {
    id: "projects",
    title: "Where your code lives",
    step: "projects",
    counts: true,
    body: () => [
      "jmux works one repository at a time — a session, a worktree and an agent per piece of work.",
      "Point it at a directory and it will offer the repositories underneath when you press Ctrl-a n.",
    ],
  },

  agents: {
    id: "agents",
    title: "Letting jmux see your agents",
    step: "agents",
    counts: true,
    body: (status) =>
      status.facts.agentsPresent.length === 0
        ? [
            "No coding agents found on this machine.",
            "jmux works fine without one: you drive tmux yourself, and the sidebar shows sessions rather than agent status. Install Claude Code, Codex or pi and this page will have something to do.",
          ]
        : [
            "jmux can show RUNNING, WAITING and COMPLETE beside each session, so you can tell at a glance which agent is stuck waiting on you. That needs a small hook in each agent's own config.",
            "It also installs a skill, so agents inside jmux can drive sibling sessions themselves.",
          ],
  },

  tracker: {
    id: "tracker",
    title: "Connect your issue tracker",
    step: "tracker",
    counts: true,
    body: () => [
      "With a tracker connected your issues appear in the info panel, and you can start a session from one — branch, worktree and agent, all named after the ticket.",
      "Verified before it is saved, so a bad paste says so rather than sitting there looking connected.",
    ],
  },

  team: {
    id: "team",
    title: "Point a project at a team",
    step: "team",
    counts: true,
    body: () => [
      "An issue has to become a branch in a repository, and jmux needs to know which.",
      "Without this, starting work from an issue does nothing at all — the most common way a new setup looks broken.",
    ],
  },

  workflow: {
    id: "workflow",
    title: "How your work moves",
    step: "workflow",
    counts: true,
    body: (status) => [
      "Your tracker's statuses group into three stages, which drive the sidebar's bands and the info panel's tabs.",
      status.steps.workflow.state === "satisfied"
        ? "Change these any time in the workflow screen — Ctrl-a W."
        : "Accept these to get started. You can change them any time in the workflow screen — Ctrl-a W.",
    ],
  },

  done: {
    id: "done",
    title: "You're set up",
    counts: false,
    body: () => [],
  },
};

/**
 * The pages this visit shows, in order.
 *
 * A page the intent asked for that this machine cannot satisfy is still
 * emitted: dropping it silently would make `Step 2 of 2` lie and would hide a
 * fact the user needs. A page the intent never asked for is simply absent,
 * which is a different thing and needs no explaining.
 */
export function pagesFor(intent: Intent, _status: SetupStatus): PageDef[] {
  if (intent === "manual") return [PAGES.welcome];
  const steps = intent === "tracker" ? TRACKER_STEPS : SOLO_STEPS;
  return [PAGES.welcome, ...steps.map((id) => PAGES[id]), PAGES.done];
}
