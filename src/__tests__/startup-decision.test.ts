import { describe, expect, test } from "bun:test";
import { PARK_SESSION } from "../glass/internal-sessions";
import { decideStartup, sessionNamesFromProbe } from "../startup-decision";

describe("decideStartup", () => {
  test("a restored session is attached strictly and wins over every other input", () => {
    expect(decideStartup({
      restoredSessionName: "remembered",
      explicitSessionName: "requested",
      existingSessionNames: ["existing"],
    })).toEqual({
      attachMode: "strictAttach",
      sessionName: "remembered",
      enterCommandCenter: false,
    });
  });

  test("an explicit session keeps the existing create-or-attach behavior", () => {
    expect(decideStartup({
      explicitSessionName: "requested",
      existingSessionNames: [],
    })).toEqual({
      attachMode: "createOrAttach",
      sessionName: "requested",
      enterCommandCenter: false,
    });
  });

  test("an existing user session keeps tmux's untargeted attachment choice", () => {
    expect(decideStartup({ existingSessionNames: [PARK_SESSION, "existing"] })).toEqual({
      attachMode: "createOrAttach",
      sessionName: undefined,
      enterCommandCenter: false,
    });
  });

  test("no user sessions boots the interactive client on park and opens Command Center", () => {
    for (const existingSessionNames of [[], [PARK_SESSION, "__jmux_tile_7"]]) {
      expect(decideStartup({ existingSessionNames })).toEqual({
        attachMode: "createOrAttach",
        sessionName: PARK_SESSION,
        enterCommandCenter: true,
      });
    }
  });

  test("an inconclusive server probe preserves the old untargeted attachment", () => {
    expect(decideStartup({ existingSessionNames: null })).toEqual({
      attachMode: "createOrAttach",
      sessionName: undefined,
      enterCommandCenter: false,
    });
  });
});

describe("sessionNamesFromProbe", () => {
  test("parses a live server and recognizes tmux's no-server outcomes", () => {
    expect(sessionNamesFromProbe({
      stdout: "alpha\n__jmux_park\n",
      stderr: "",
      exitCode: 0,
    })).toEqual(["alpha", "__jmux_park"]);
    expect(sessionNamesFromProbe({
      stdout: "",
      stderr: "no server running on /tmp/tmux-501/test",
      exitCode: 1,
    })).toEqual([]);
  });

  test("does not call an unrelated tmux failure an empty server", () => {
    expect(sessionNamesFromProbe({
      stdout: "",
      stderr: "permission denied",
      exitCode: 1,
    })).toBeNull();
    expect(sessionNamesFromProbe({
      stdout: "",
      stderr: "error connecting to /tmp/tmux-501/test (Permission denied)",
      exitCode: 1,
    })).toBeNull();
  });

  test("recognizes missing and dead tmux sockets as an empty server", () => {
    for (const stderr of [
      "error connecting to /tmp/tmux-501/test (No such file or directory)",
      "error connecting to /tmp/tmux-501/test (Connection refused)",
    ]) {
      expect(sessionNamesFromProbe({ stdout: "", stderr, exitCode: 1 })).toEqual([]);
    }
  });
});
