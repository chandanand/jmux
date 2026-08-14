import { describe, expect, test } from "bun:test";
import { deriveStatus, type SetupFacts } from "../onboarding/status";
import { OnboardingFlow } from "../onboarding/flow";
import { pagesFor, INTENT_CHOICES, MAP_STEPS } from "../onboarding/pages";

const facts: SetupFacts = {
  agentsPresent: ["Claude Code"], agentsStale: ["Claude Code"], skillCurrent: false,
  namingConfigured: false, namingAvailable: ["claude"],
  trackerType: "linear", trackerAuthed: false, trackerDeclined: false,
  projectCount: 0, attachedTeamCount: 0, workflowTabCount: 0, hunkInstalled: false,
};
const status = deriveStatus(facts);
const flow = (s = status) => new OnboardingFlow(s);
const ids = (f: OnboardingFlow) => f.pages().map((p) => p.id);

describe("pagesFor", () => {
  test("solo is welcome, the two steps, done", () => {
    expect(pagesFor("solo", status).map((p) => p.id))
      .toEqual(["welcome", "projects", "agents", "naming", "done"]);
  });

  test("tracker adds its three pages before done", () => {
    expect(pagesFor("tracker", status).map((p) => p.id))
      .toEqual(["welcome", "projects", "agents", "naming", "tracker", "team", "workflow", "done"]);
  });

  test("manual is welcome alone — nothing configured, nothing claimed", () => {
    expect(pagesFor("manual", status).map((p) => p.id)).toEqual(["welcome"]);
  });

  // A page the intent never asked for is absent; a page it asked for that this
  // machine cannot satisfy is still shown, with prose saying why. Dropping the
  // second silently would make the step count lie.
  test("a page the intent did not ask for is absent", () => {
    expect(pagesFor("solo", status).map((p) => p.id)).not.toContain("tracker");
  });

  test("an unavailable page is still emitted", () => {
    const noAgents = deriveStatus({ ...facts, agentsPresent: [], agentsStale: [] });
    expect(noAgents.steps.agents.state).toBe("unavailable");
    expect(pagesFor("solo", noAgents).map((p) => p.id)).toContain("agents");
  });

  test("welcome and done are not steps", () => {
    expect(pagesFor("solo", status).filter((p) => p.counts).map((p) => p.id))
      .toEqual(["projects", "agents", "naming"]);
  });

  test("every page has a title and at least one paragraph", () => {
    for (const page of pagesFor("tracker", status)) {
      expect(page.title.length).toBeGreaterThan(0);
      if (page.id !== "done") expect(page.body(status).length).toBeGreaterThan(0);
    }
  });

  test("the agents page says what it cannot do when there is no agent", () => {
    const noAgents = deriveStatus({ ...facts, agentsPresent: [], agentsStale: [] });
    const page = pagesFor("solo", noAgents).find((p) => p.id === "agents")!;
    const text = page.body(noAgents).join(" ");
    expect(text).toContain("No coding agents found");
    // Honest, and explicitly not a failure.
    expect(text).toContain("jmux works fine without one");
  });

  test("the welcome page's promised step count matches the pages that follow", () => {
    for (const choice of INTENT_CHOICES) {
      if (choice.id === "manual") continue;
      const counted = pagesFor(choice.id, status).filter((p) => p.counts).length;
      expect(choice.cost).toContain(String(counted));
    }
  });
});

describe("OnboardingFlow — navigation", () => {
  test("starts on welcome", () => {
    const f = flow();
    expect(f.view()).toBe("page");
    expect(f.currentPage().id).toBe("welcome");
  });

  test("choosing an intent moves to the first real page", () => {
    const f = flow();
    f.chooseIntent("solo");
    expect(f.currentPage().id).toBe("projects");
  });

  test("manual goes straight to the map", () => {
    const f = flow();
    f.chooseIntent("manual");
    expect(f.view()).toBe("map");
  });

  // Blocking advance on an unsatisfied page is what would make "no tracker
  // account today" unrecoverable.
  test("next advances even when the page is not satisfied", () => {
    const f = flow();
    f.chooseIntent("solo");
    expect(status.steps.projects.state).toBe("pending");
    f.next();
    expect(f.currentPage().id).toBe("agents");
  });

  test("next stops at the last page rather than wrapping", () => {
    const f = flow();
    f.chooseIntent("solo");
    for (let i = 0; i < 10; i++) f.next();
    expect(f.currentPage().id).toBe("done");
  });

  // Back stops at the first real page: re-asking the intent question would
  // silently discard the answer behind you.
  test("back stops at the first real page rather than the intent question", () => {
    const f = flow();
    f.chooseIntent("solo");
    for (let i = 0; i < 10; i++) f.back();
    expect(f.currentPage().id).toBe("projects");
  });

  test("navigation never lands outside the emitted set", () => {
    const f = flow();
    f.chooseIntent("tracker");
    for (let i = 0; i < 20; i++) f.next();
    expect(ids(f)).toContain(f.currentPage().id);
    for (let i = 0; i < 20; i++) f.back();
    expect(ids(f)).toContain(f.currentPage().id);
  });

  test("the intent cursor wraps in both directions", () => {
    const f = flow();
    expect(f.getIntentIndex()).toBe(0);
    f.moveIntent(-1);
    expect(f.getIntentIndex()).toBe(INTENT_CHOICES.length - 1);
    f.moveIntent(1);
    expect(f.getIntentIndex()).toBe(0);
  });
});

describe("OnboardingFlow — zoom out", () => {
  test("page to map, map to close", () => {
    const f = flow();
    f.chooseIntent("solo");
    expect(f.zoomOut()).toBe("map");
    expect(f.view()).toBe("map");
    expect(f.zoomOut()).toBe("close");
  });

  test("from welcome with no intent chosen, it closes outright", () => {
    expect(flow().zoomOut()).toBe("close");
  });

  test("openStep from the map lands on that page", () => {
    const f = flow();
    f.chooseIntent("solo");
    f.zoomOut();
    f.openStep("agents");
    expect(f.view()).toBe("page");
    expect(f.currentPage().id).toBe("agents");
  });

  // This asserted the opposite until the map grew a visible cursor: a row was
  // drawn for every step, and choosing one outside the current arm silently
  // did nothing. Refusing to open a row you have drawn is the worse half of
  // that bug, so the rule is now that the map's rows all open.
  test("openStep for a page outside this intent adopts the arm that has it", () => {
    const f = flow();
    f.chooseIntent("solo");
    f.openStep("tracker");
    expect(f.currentPage().id).toBe("tracker");
  });
});

describe("OnboardingFlow — step numbering", () => {
  test("counts only real steps, and matches the promise", () => {
    const f = flow();
    f.chooseIntent("solo");
    expect(f.stepLabel()).toBe("Step 1 of 3");
    f.next();
    expect(f.stepLabel()).toBe("Step 2 of 3");
  });

  test("welcome and done carry no step label", () => {
    const f = flow();
    expect(f.stepLabel()).toBeNull();
    f.chooseIntent("solo");
    for (let i = 0; i < 10; i++) f.next();
    expect(f.currentPage().id).toBe("done");
    expect(f.stepLabel()).toBeNull();
  });
});

describe("OnboardingFlow — async actions", () => {
  test("a duplicate action while busy is refused, not queued", () => {
    const f = flow();
    f.chooseIntent("solo");
    expect(f.beginAction()).toBe(true);
    expect(f.beginAction()).toBe(false);
    f.endAction();
    expect(f.beginAction()).toBe(true);
  });

  test("busy locks navigation, so a page cannot change under its own action", () => {
    const f = flow();
    f.chooseIntent("solo");
    f.beginAction();
    f.next();
    expect(f.currentPage().id).toBe("projects");
    f.endAction();
    f.next();
    expect(f.currentPage().id).toBe("agents");
  });
});

describe("OnboardingFlow — restatus", () => {
  test("keeps the cursor on its page when the world changes underneath", () => {
    const f = flow();
    f.chooseIntent("tracker");
    f.openStep("tracker");
    expect(f.currentPage().id).toBe("tracker");
    f.setStatus(deriveStatus({ ...facts, trackerAuthed: true }));
    expect(f.currentPage().id).toBe("tracker");
  });

  test("a declined tracker keeps the tracker arm out of the solo set", () => {
    const f = flow(deriveStatus({ ...facts, trackerDeclined: true }));
    f.chooseIntent("solo");
    expect(ids(f)).not.toContain("tracker");
  });
});

describe("the map lists every step, and every listed step opens", () => {
  // The map is an overview, not a second copy of the sequence: a solo user
  // seeing "Connect an issue tracker — not yet" learns something the sequence
  // never told them. But a row that is drawn and refuses to open is worse than
  // one that was never drawn.
  test("opening a step outside the current arm adopts the arm that has it", () => {
    const f = flow();
    f.chooseIntent("solo");
    expect(ids(f)).not.toContain("tracker");

    f.zoomOut();
    f.openStep("tracker");
    expect(f.view()).toBe("page");
    expect(f.currentPage().id).toBe("tracker");
    expect(ids(f)).toContain("tracker");
  });

  test("every row the map lists is reachable", () => {
    for (const step of MAP_STEPS) {
      const f = flow();
      f.chooseIntent("solo");
      f.zoomOut();
      f.openStep(step);
      expect([step, f.currentPage().id]).toEqual([step, step]);
    }
  });

  test("adopting an arm keeps the step count honest", () => {
    const f = flow();
    f.chooseIntent("solo");
    f.zoomOut();
    f.openStep("workflow");
    expect(f.stepLabel()).toBe("Step 6 of 6");
  });
});
