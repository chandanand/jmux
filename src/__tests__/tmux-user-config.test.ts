import { describe, expect, test } from "bun:test";
import {
  editableUserTmuxConfig,
  formatUserTmuxConfig,
  parseUserTmuxConfig,
  resolveUserTmuxConfig,
  userTmuxConfigWarning,
} from "../tmux-user-config";

const HOME = "/home/dylan";
const DOT = `${HOME}/.tmux.conf`;
const XDG = `${HOME}/.config/tmux/tmux.conf`;

/** `exists` over a fixed set — the only filesystem this module ever sees. */
function present(...paths: string[]) {
  const set = new Set(paths);
  return (path: string) => set.has(path);
}

const env = { home: HOME };

describe("resolveUserTmuxConfig — auto-detect", () => {
  test("prefers ~/.tmux.conf, the location jmux has always used", () => {
    expect(resolveUserTmuxConfig(undefined, env, present(DOT, XDG))).toEqual({
      kind: "source",
      path: DOT,
      origin: "auto",
    });
  });

  // tmux's own man page: "~/.tmux.conf or $XDG_CONFIG_HOME/tmux/tmux.conf".
  // jmux checked only the first for its whole life, so a user living at the
  // second had their config silently ignored — and would have been handed an
  // off switch for something that was never on.
  test("falls through to the XDG location", () => {
    expect(resolveUserTmuxConfig(undefined, env, present(XDG))).toEqual({
      kind: "source",
      path: XDG,
      origin: "auto",
    });
  });

  test("honors $XDG_CONFIG_HOME over the ~/.config default", () => {
    const custom = "/elsewhere/tmux/tmux.conf";
    const withXdg = { home: HOME, xdgConfigHome: "/elsewhere" };
    expect(resolveUserTmuxConfig(undefined, withXdg, present(custom, XDG))).toEqual({
      kind: "source",
      path: custom,
      origin: "auto",
    });
  });

  test("finding nothing is 'none', not 'disabled'", () => {
    expect(resolveUserTmuxConfig(undefined, env, present())).toEqual({ kind: "none" });
  });

  test("a blank string is no opinion, not an empty path", () => {
    expect(resolveUserTmuxConfig("   ", env, present(DOT))).toEqual({
      kind: "source",
      path: DOT,
      origin: "auto",
    });
  });

  test("no home directory leaves nothing to auto-detect", () => {
    expect(resolveUserTmuxConfig(undefined, { home: "" }, present(DOT, XDG))).toEqual({
      kind: "none",
    });
  });
});

describe("resolveUserTmuxConfig — configured", () => {
  test("false means source nothing", () => {
    expect(resolveUserTmuxConfig(false, env, present(DOT, XDG))).toEqual({ kind: "disabled" });
  });

  test("a path is used verbatim and marked configured", () => {
    const own = "/opt/jmux.tmux.conf";
    expect(resolveUserTmuxConfig(own, env, present(own, DOT))).toEqual({
      kind: "source",
      path: own,
      origin: "configured",
    });
  });

  test("expands a leading ~, which a hand-edited JSON file will carry", () => {
    expect(resolveUserTmuxConfig("~/alt.conf", env, present(`${HOME}/alt.conf`))).toEqual({
      kind: "source",
      path: `${HOME}/alt.conf`,
      origin: "configured",
    });
  });

  test("bare ~ is the home directory, not a file named ~", () => {
    expect(resolveUserTmuxConfig("~", env, present(HOME))).toEqual({
      kind: "source",
      path: HOME,
      origin: "configured",
    });
  });

  test("does not expand ~user — that is not this module's syntax", () => {
    expect(resolveUserTmuxConfig("~bob/x.conf", env, present("~bob/x.conf"))).toEqual({
      kind: "source",
      path: "~bob/x.conf",
      origin: "configured",
    });
  });

  // Falling back to auto-detect here would source a *different file than the
  // one named*, confidently and silently. An honest nothing is better.
  test("a configured path that is absent never falls back to auto-detect", () => {
    expect(resolveUserTmuxConfig("~/gone.conf", env, present(DOT, XDG))).toEqual({
      kind: "missing",
      path: `${HOME}/gone.conf`,
    });
  });
});

describe("userTmuxConfigWarning", () => {
  test("names the missing file and says what jmux did about it", () => {
    const warning = userTmuxConfigWarning({ kind: "missing", path: "/x/gone.conf" });
    expect(warning).toContain("/x/gone.conf");
    expect(warning).toContain("userTmuxConfig");
  });

  test("every other resolution is silent", () => {
    expect(userTmuxConfigWarning({ kind: "disabled" })).toBeNull();
    expect(userTmuxConfigWarning({ kind: "none" })).toBeNull();
    expect(
      userTmuxConfigWarning({ kind: "source", path: DOT, origin: "auto" }),
    ).toBeNull();
  });
});

describe("formatUserTmuxConfig", () => {
  // The row discloses *why* it reads as it does, the same construction the
  // inline-images row uses: a bare "auto" would let it claim a config is in
  // force on a machine that has none.
  test("auto says which file it landed on", () => {
    expect(formatUserTmuxConfig({ kind: "source", path: DOT, origin: "auto" }, HOME)).toBe(
      "auto (~/.tmux.conf)",
    );
  });

  test("auto that found nothing says so", () => {
    expect(formatUserTmuxConfig({ kind: "none" }, HOME)).toBe("auto (none found)");
  });

  test("a configured path is shown alone", () => {
    expect(
      formatUserTmuxConfig({ kind: "source", path: `${HOME}/alt.conf`, origin: "configured" }, HOME),
    ).toBe("~/alt.conf");
  });

  test("a missing path is shown with its failure", () => {
    expect(formatUserTmuxConfig({ kind: "missing", path: `${HOME}/gone.conf` }, HOME)).toBe(
      "~/gone.conf (not found)",
    );
  });

  test("off is off", () => {
    expect(formatUserTmuxConfig({ kind: "disabled" }, HOME)).toBe("off");
  });

  test("a path outside home keeps its full form", () => {
    expect(
      formatUserTmuxConfig({ kind: "source", path: "/opt/x.conf", origin: "configured" }, HOME),
    ).toBe("/opt/x.conf");
  });

  test("a home-prefixed path that is not a child is not contracted", () => {
    expect(
      formatUserTmuxConfig(
        { kind: "source", path: `${HOME}-backup/x.conf`, origin: "configured" },
        HOME,
      ),
    ).toBe(`${HOME}-backup/x.conf`);
  });
});

describe("editable / parse round-trip", () => {
  // getValue's form has the resolution in parentheses and does not survive
  // being fed back in — which is exactly what getEditValue exists for.
  test.each([
    [undefined, "auto"],
    [false as const, "off"],
    ["~/alt.conf", "~/alt.conf"],
  ])("%p edits as %p and parses back", (value, editable) => {
    expect(editableUserTmuxConfig(value)).toBe(editable);
    expect(parseUserTmuxConfig(editable)).toBe(value as string | false | undefined);
  });

  test.each(["off", "none", "false", "no", "OFF"])("%p turns it off", (input) => {
    expect(parseUserTmuxConfig(input)).toBe(false);
  });

  test.each(["", "   ", "auto", "default", "AUTO"])("%p means auto", (input) => {
    expect(parseUserTmuxConfig(input)).toBeUndefined();
  });

  test("a path keeps its case and loses only surrounding space", () => {
    expect(parseUserTmuxConfig("  ~/Alt.conf  ")).toBe("~/Alt.conf");
  });
});
