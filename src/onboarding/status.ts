/**
 * What is true about this machine's setup, as one immutable value.
 *
 * Owned above the flow rather than inside it, for two reasons. The toolbar dot
 * needs an answer when no onboarding surface is open at all; and the config
 * watcher can reload projects, workflow views and declared intent while the
 * flow *is* open, so a snapshot refreshed only by the flow's own actions would
 * go stale under the user's own edit.
 *
 * Derivation is pure over injected facts. Gathering them touches the
 * filesystem, adapters and tmux; deciding what they mean does not, which is
 * what makes every state below reachable in a test.
 */

export type StepId = "projects" | "agents" | "naming" | "tracker" | "team" | "workflow";

export type StepState =
  /** Already true on this machine. */
  | "satisfied"
  /** Not yet, and the flow can do something about it. */
  | "pending"
  /**
   * Not yet, and it cannot happen here — no agent installed, no tracker
   * connected yet, or the user has said never.
   *
   * Distinct from `pending` because it must never drive the toolbar dot.
   * Nagging someone about something jmux cannot do is how a setup surface
   * becomes furniture they learn to ignore.
   */
  | "unavailable";

export interface StepStatus {
  state: StepState;
  /**
   * The right-hand column on the map: what this amounts to, in words.
   *
   * Never a raw fact. "5 failing" and "none configured" tell a new user
   * nothing about what is broken or whether they may safely skip it.
   */
  summary: string;
}

/** Everything gathered from the world. Assembled by main.ts, read only here. */
export interface SetupFacts {
  /** Labels of agents installed on this machine. */
  agentsPresent: string[];
  /** Of those, the ones whose hooks are absent or out of date. */
  agentsStale: string[];
  skillCurrent: boolean;
  /** Whether `sessionTitle.command` is configured. */
  namingConfigured: boolean;
  /** `setup.sessionTitle === "never"` — declared, and undetectable otherwise. */
  namingDeclined: boolean;
  /** Preset ids whose binary is actually on PATH — only these are offered. */
  namingAvailable: string[];
  trackerType: string | null;
  trackerAuthed: boolean;
  /** `setup.tracker === "never"` — declared intent, which nothing can detect. */
  trackerDeclined: boolean;
  projectCount: number;
  attachedTeamCount: number;
  workflowTabCount: number;
  hunkInstalled: boolean;
}

export interface SetupStatus {
  steps: Record<StepId, StepStatus>;
  /** Whether anything the user could act on is still outstanding. */
  outstanding: boolean;
  facts: SetupFacts;
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

export function deriveStatus(facts: SetupFacts): SetupStatus {
  const projects: StepStatus = facts.projectCount > 0
    ? { state: "satisfied", summary: plural(facts.projectCount, "project", "projects") }
    : { state: "pending", summary: "not yet" };

  // Per-agent: one that is not installed here is not a gap, so it counts
  // neither way. The skill is folded in because it is the same idea and the
  // same keystroke — jmux and your agents seeing each other.
  const agents: StepStatus = facts.agentsPresent.length === 0
    ? { state: "unavailable", summary: "no agents found" }
    : facts.agentsStale.length === 0 && facts.skillCurrent
      ? { state: "satisfied", summary: facts.agentsPresent.join(", ") }
      : {
          state: "pending",
          summary: facts.agentsStale.length > 0
            ? `${facts.agentsStale.length} to set up`
            : "skill not installed",
        };

  // The naming presets are the agent CLIs, so a machine with none installed
  // has nothing to offer here — unavailable rather than pending, so it cannot
  // raise the toolbar dot on a machine that can never satisfy it.
  const naming: StepStatus = facts.namingConfigured
    ? { state: "satisfied", summary: "on" }
    : facts.namingDeclined
      ? { state: "unavailable", summary: "not for me" }
      : facts.namingAvailable.length === 0
        ? { state: "unavailable", summary: "needs an agent CLI" }
        : { state: "pending", summary: "not yet" };

  const tracker: StepStatus = facts.trackerAuthed
    ? { state: "satisfied", summary: facts.trackerType ?? "connected" }
    : facts.trackerDeclined
      ? { state: "unavailable", summary: "not for me" }
      : { state: "pending", summary: "not yet" };

  // Both only mean anything once a tracker answers. Unavailable rather than
  // pending until then, so neither can raise the dot on a machine with no
  // tracker configured at all.
  const gated = (ok: boolean, summary: string): StepStatus =>
    !facts.trackerAuthed
      ? { state: "unavailable", summary: "needs a tracker" }
      : ok
        ? { state: "satisfied", summary }
        : { state: "pending", summary: "not yet" };

  const team = gated(
    facts.attachedTeamCount > 0,
    plural(facts.attachedTeamCount, "team routed", "teams routed"),
  );
  const workflow = gated(
    facts.workflowTabCount > 0,
    plural(facts.workflowTabCount, "stage", "stages"),
  );

  const steps: Record<StepId, StepStatus> = { projects, agents, naming, tracker, team, workflow };
  return {
    steps,
    outstanding: Object.values(steps).some((s) => s.state === "pending"),
    facts,
  };
}
