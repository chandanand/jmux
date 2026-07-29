import { describe, test, expect } from "bun:test";
import { resolveNavStep, type NavTarget, type NavFocus } from "../nav-order";

const S = (id: string): NavTarget => ({ type: "session", sessionId: id });
const G = (id: string): NavTarget => ({ type: "ghost", issueId: id });

const OVERVIEW: NavFocus = { type: "overview" };
const onSession = (id: string): NavFocus => ({ type: "session", sessionId: id });
const onGhost = (id: string): NavFocus => ({ type: "ghost", issueId: id });

describe("resolveNavStep", () => {
  test("Overview is the first stop, before any target", () => {
    const targets = [S("$1"), S("$2")];
    expect(resolveNavStep(targets, OVERVIEW, 1)).toEqual(onSession("$1"));
    expect(resolveNavStep(targets, onSession("$1"), -1)).toEqual(OVERVIEW);
  });

  test("walks sessions and ghosts as one list", () => {
    const targets = [S("$1"), G("i1"), S("$2")];
    expect(resolveNavStep(targets, onSession("$1"), 1)).toEqual(onGhost("i1"));
    expect(resolveNavStep(targets, onGhost("i1"), 1)).toEqual(onSession("$2"));
    expect(resolveNavStep(targets, onSession("$2"), -1)).toEqual(onGhost("i1"));
  });

  test("wraps at both ends through Overview", () => {
    const targets = [S("$1"), S("$2")];
    expect(resolveNavStep(targets, onSession("$2"), 1)).toEqual(OVERVIEW);
    expect(resolveNavStep(targets, OVERVIEW, -1)).toEqual(onSession("$2"));
  });

  describe("empty target list", () => {
    // The case the first draft of this feature got wrong: falling back to
    // "position 1" indexes into nothing when there are no targets at all.
    test("stays on Overview in both directions", () => {
      expect(resolveNavStep([], OVERVIEW, 1)).toEqual(OVERVIEW);
      expect(resolveNavStep([], OVERVIEW, -1)).toEqual(OVERVIEW);
    });

    test("resolves a stale focus to Overview rather than throwing", () => {
      expect(resolveNavStep([], onSession("$gone"), 1)).toEqual(OVERVIEW);
      expect(resolveNavStep([], onGhost("gone"), -1)).toEqual(OVERVIEW);
    });
  });

  describe("focus absent from the target list", () => {
    // A filter removed the current session, or the focused ghost gained a
    // session and stopped being a ghost, between one keypress and the next.
    const targets = [S("$1"), S("$2")];

    test("enters at the first target and steps from there", () => {
      expect(resolveNavStep(targets, onGhost("vanished"), 1)).toEqual(onSession("$2"));
      expect(resolveNavStep(targets, onSession("$gone"), 1)).toEqual(onSession("$2"));
    });

    test("steps backwards from the first target onto Overview", () => {
      expect(resolveNavStep(targets, onGhost("vanished"), -1)).toEqual(OVERVIEW);
    });
  });

  test("a single target cycles with Overview", () => {
    const targets = [G("i1")];
    expect(resolveNavStep(targets, OVERVIEW, 1)).toEqual(onGhost("i1"));
    expect(resolveNavStep(targets, onGhost("i1"), 1)).toEqual(OVERVIEW);
    expect(resolveNavStep(targets, onGhost("i1"), -1)).toEqual(OVERVIEW);
  });

  test("offsets larger than the cycle wrap rather than overrunning", () => {
    const targets = [S("$1"), S("$2")];
    expect(resolveNavStep(targets, OVERVIEW, 3)).toEqual(OVERVIEW);
    expect(resolveNavStep(targets, OVERVIEW, 4)).toEqual(onSession("$1"));
    // -4 over a 3-stop cycle is -1: one step back from Overview is the last target.
    expect(resolveNavStep(targets, OVERVIEW, -4)).toEqual(onSession("$2"));
  });

  test("a session and a ghost sharing an id string are not confused", () => {
    const targets = [S("x"), G("x")];
    expect(resolveNavStep(targets, onSession("x"), 1)).toEqual(onGhost("x"));
    expect(resolveNavStep(targets, onGhost("x"), -1)).toEqual(onSession("x"));
  });
});
