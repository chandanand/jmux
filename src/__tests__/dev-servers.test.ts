import { describe, test, expect } from "bun:test";
import {
  parseListeners,
  parseProcessTree,
  parsePaneProcesses,
  parseCommands,
  descendants,
  isLocallyReachable,
  attributeListeners,
  devServerUrl,
} from "../dev-servers";

// Real `lsof -nP -iTCP -sTCP:LISTEN -F pn` output, including the two things
// that make it awkward: a port bound twice (v4 and v6) and an IPv6 address
// whose own colons must not be mistaken for the port separator.
const LSOF = [
  "p1018", "f11", "n*:49238", "f15", "n*:49238",
  "p1139", "f9", "n*:7000", "f10", "n*:7000", "f11", "n*:5000",
  "p1724", "f53", "n127.0.0.1:41343",
  "p1830", "f85", "n[::1]:5860",
  "p1900", "f3", "n192.168.1.9:8080",
].join("\n");

describe("parseListeners", () => {
  test("associates each address with the process block above it", () => {
    const found = parseListeners(LSOF);
    expect(found.find((l) => l.port === 5000)?.pid).toBe(1139);
    expect(found.find((l) => l.port === 41343)?.pid).toBe(1724);
  });

  test("collapses a port bound on both IPv4 and IPv6", () => {
    // Two file descriptors, one server. Offering it twice is a bug the user
    // sees as a duplicated picker entry.
    expect(parseListeners(LSOF).filter((l) => l.port === 7000)).toHaveLength(1);
    expect(parseListeners(LSOF).filter((l) => l.port === 49238)).toHaveLength(1);
  });

  test("splits an IPv6 address from its port at the last colon", () => {
    const v6 = parseListeners(LSOF).find((l) => l.port === 5860);
    expect(v6?.address).toBe("[::1]");
  });

  test("ignores lines that belong to no process", () => {
    expect(parseListeners("n*:3000\nf3")).toEqual([]);
  });

  test("survives junk without throwing", () => {
    expect(parseListeners("")).toEqual([]);
    expect(parseListeners("p\nnnonsense\nn*:notaport")).toEqual([]);
  });
});

describe("parseProcessTree / descendants", () => {
  const PS = ["1 0", "100 1", "200 100", "300 200", "400 1", "500 400"].join("\n");

  test("finds everything under a root, at any depth", () => {
    // A dev server is a grandchild at least: shell → npm → node.
    const tree = parseProcessTree(PS);
    expect([...descendants(100, tree)].sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  test("includes the root itself", () => {
    expect(descendants(400, parseProcessTree(PS)).has(400)).toBe(true);
  });

  test("a leaf is just itself", () => {
    expect([...descendants(300, parseProcessTree(PS))]).toEqual([300]);
  });

  test("terminates on a cycle rather than hanging", () => {
    // pids get reused; a tree read mid-reuse can name itself an ancestor, and
    // recursion over that is a hang, not a wrong answer.
    const cyclic = parseProcessTree(["10 20", "20 10"].join("\n"));
    expect(descendants(10, cyclic).size).toBeLessThanOrEqual(2);
  });
});

describe("isLocallyReachable", () => {
  test("accepts wildcard and loopback binds", () => {
    for (const a of ["*", "0.0.0.0", "127.0.0.1", "[::1]", "::1", "[::]"]) {
      expect(isLocallyReachable(a)).toBe(true);
    }
  });

  test("rejects an address this machine's browser cannot reach", () => {
    // A VPN or container-bridge bind produces a URL that never loads, which is
    // worse than not offering it.
    expect(isLocallyReachable("192.168.1.9")).toBe(false);
    expect(isLocallyReachable("10.0.0.4")).toBe(false);
  });
});

describe("attributeListeners", () => {
  const tree = parseProcessTree(["100 1", "200 100", "300 1", "400 300"].join("\n"));
  const panes = parsePaneProcesses(["web\t%1\t100", "api\t%2\t300"]);
  const listeners = parseListeners(
    ["p200", "f3", "n*:3000", "p400", "f3", "n127.0.0.1:8080"].join("\n"),
  );

  test("attributes a port to the session whose pane owns the process", () => {
    const found = attributeListeners(listeners, panes, tree);
    expect(found).toHaveLength(2);
    expect(found.find((s) => s.port === 3000)?.session).toBe("web");
    expect(found.find((s) => s.port === 8080)?.session).toBe("api");
  });

  test("ignores a listener belonging to no pane", () => {
    // Everything else on the machine — and jmux's own OTEL receiver and hunk
    // daemon, which are children of the TUI rather than of any pane.
    const stray = parseListeners(["p999", "f3", "n*:9999"].join("\n"));
    expect(attributeListeners(stray, panes, tree)).toEqual([]);
  });

  test("drops a listener bound where a local browser cannot reach it", () => {
    const remote = parseListeners(["p200", "f3", "n192.168.1.9:3000"].join("\n"));
    expect(attributeListeners(remote, panes, tree)).toEqual([]);
  });

  test("offers a server once even when panes nest", () => {
    // A shell inside a shell means the same pid is under two pane roots.
    const nested = parsePaneProcesses(["web\t%1\t100", "web\t%2\t200"]);
    expect(attributeListeners(listeners, nested, tree).filter((s) => s.port === 3000))
      .toHaveLength(1);
  });

  test("sorts by port so a picker does not reshuffle between opens", () => {
    const many = parseListeners(
      ["p200", "f3", "n*:8080", "f4", "n*:3000", "f5", "n*:5173"].join("\n"),
    );
    expect(attributeListeners(many, panes, tree).map((s) => s.port)).toEqual([3000, 5173, 8080]);
  });

  test("carries the listening process's name when it is known", () => {
    const commands = parseCommands(["200 node", "400 /opt/homebrew/bin/python3"].join("\n"));
    const found = attributeListeners(listeners, panes, tree, commands);
    expect(found.find((s) => s.port === 3000)?.command).toBe("node");
    // The program, not the path it was started from.
    expect(found.find((s) => s.port === 8080)?.command).toBe("python3");
  });
});

describe("devServerUrl", () => {
  test("always addresses localhost, whatever the bind was", () => {
    // `*:3000` is not a URL. What the user wants is the one that works here.
    expect(devServerUrl({ session: "s", paneId: "%1", port: 3000, address: "*", pid: 1, command: "" }))
      .toBe("http://localhost:3000");
  });
});
