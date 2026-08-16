import { describe, test, expect } from "bun:test";
import {
  scanForGraphics,
  scanForTerminalQueries,
  MAX_PENDING,
  PlacementTracker,
} from "../images/passthrough";

/** A virtual-placement transmit of the shape terminal-browser emits under tmux. */
const TRANSMIT = "\x1b_Ga=T,f=32,s=800,v=600,t=s,i=4207,U=1,c=80,r=24,q=2;L3B4LTEyMy0w\x1b\\";
const DELETE = "\x1b_Ga=d,d=I,i=4207,q=2\x1b\\";

/** Feed a whole stream one byte at a time — the worst case tmux can produce. */
function scanByteByByte(stream: string) {
  let pending = "";
  let relay = "";
  let rest = "";
  for (const byte of stream) {
    const out = scanForGraphics(pending, byte);
    pending = out.pending;
    relay += out.relay;
    rest += out.rest;
  }
  return { relay, rest, pending };
}

describe("scanForTerminalQueries", () => {
  test("lifts Yazi's XTVERSION and DA1 queries out of pane output", () => {
    const out = scanForTerminalQueries("", "before\x1b[>qmid\x1b[cafter");
    expect(out.relay).toBe("\x1b[>q\x1b[c");
    expect(out.rest).toBe("beforemidafter");
    expect(out.pending).toBe("");
  });

  test("accepts the explicit DA1 zero parameter", () => {
    const out = scanForTerminalQueries("", "\x1b[0c");
    expect(out.relay).toBe("\x1b[0c");
    expect(out.rest).toBe("");
  });

  test("leaves ordinary CSI output untouched", () => {
    const input = "\x1b[31mred\x1b[0m";
    const out = scanForTerminalQueries("", input);
    expect(out.relay).toBe("");
    expect(out.rest).toBe(input);
    expect(out.pending).toBe("");
  });

  test("reassembles a query delivered one byte at a time", () => {
    let pending = "";
    let relay = "";
    let rest = "";
    for (const byte of "head\x1b[>qtail") {
      const out = scanForTerminalQueries(pending, byte);
      pending = out.pending;
      relay += out.relay;
      rest += out.rest;
    }
    expect(relay).toBe("\x1b[>q");
    expect(rest).toBe("headtail");
    expect(pending).toBe("");
  });
});

describe("scanForGraphics", () => {
  test("passes ordinary output through untouched", () => {
    const out = scanForGraphics("", "hello\x1b[31mworld\x1b[0m");
    expect(out.relay).toBe("");
    expect(out.rest).toBe("hello\x1b[31mworld\x1b[0m");
    expect(out.pending).toBe("");
  });

  test("lifts a graphics sequence out of the stream", () => {
    const out = scanForGraphics("", `before${TRANSMIT}after`);
    expect(out.relay).toBe(TRANSMIT);
    expect(out.rest).toBe("beforeafter");
    expect(out.pending).toBe("");
  });

  // Removal, not duplication: the screen model has no use for these bytes, and
  // leaving them in would bet on the headless terminal continuing to discard an
  // APC it does not implement rather than printing the payload as text.
  test("removes the sequence from what the screen model sees", () => {
    const out = scanForGraphics("", TRANSMIT);
    expect(out.rest).toBe("");
  });

  test("handles several sequences in one chunk", () => {
    const out = scanForGraphics("", `a${TRANSMIT}b${DELETE}c`);
    expect(out.relay).toBe(TRANSMIT + DELETE);
    expect(out.rest).toBe("abc");
  });

  test("accepts BEL as a terminator", () => {
    const bel = "\x1b_Ga=d,d=I,i=9,q=2\x07";
    const out = scanForGraphics("", `x${bel}y`);
    expect(out.relay).toBe(bel);
    expect(out.rest).toBe("xy");
  });

  test("leaves non-graphics APC strings alone", () => {
    const other = "\x1b_Xsomething\x1b\\";
    const out = scanForGraphics("", other);
    expect(out.relay).toBe("");
    expect(out.rest).toBe(other);
  });

  describe("split across reads", () => {
    test("holds an unterminated sequence and completes it next chunk", () => {
      const half = TRANSMIT.slice(0, 30);
      const first = scanForGraphics("", `text${half}`);
      expect(first.relay).toBe("");
      expect(first.pending).toBe(half);
      // Text before the introducer is released immediately — holding it would
      // stall the pane behind a sequence it has nothing to do with.
      expect(first.rest).toBe("text");

      const second = scanForGraphics(first.pending, TRANSMIT.slice(30) + "tail");
      expect(second.relay).toBe(TRANSMIT);
      expect(second.rest).toBe("tail");
      expect(second.pending).toBe("");
    });

    test("survives a split inside the ST terminator", () => {
      const upToEsc = TRANSMIT.slice(0, TRANSMIT.length - 1); // ends with lone ESC
      const first = scanForGraphics("", upToEsc);
      expect(first.relay).toBe("");
      expect(first.pending).toBe(upToEsc);

      const second = scanForGraphics(first.pending, "\\");
      expect(second.relay).toBe(TRANSMIT);
      expect(second.pending).toBe("");
    });

    // The introducer splitting is not an edge case: at 60fps it is a
    // certainty, and it was the first thing the byte-at-a-time test caught.
    test("holds a trailing fragment of the introducer itself", () => {
      const first = scanForGraphics("", "text\x1b");
      expect(first.rest).toBe("text");
      expect(first.pending).toBe("\x1b");

      const second = scanForGraphics(first.pending, "_G");
      expect(second.rest).toBe("");
      expect(second.pending).toBe("\x1b_G");
    });

    test("releases a held ESC as soon as it proves to be an ordinary CSI", () => {
      const first = scanForGraphics("", "text\x1b");
      expect(first.pending).toBe("\x1b");

      const second = scanForGraphics(first.pending, "[31m");
      expect(second.relay).toBe("");
      expect(second.rest).toBe("\x1b[31m");
      expect(second.pending).toBe("");
    });

    test("reassembles correctly when delivered one byte at a time", () => {
      const out = scanByteByByte(`head${TRANSMIT}mid${DELETE}tail`);
      expect(out.relay).toBe(TRANSMIT + DELETE);
      expect(out.rest).toBe("headmidtail");
      expect(out.pending).toBe("");
    });
  });

  describe("stray introducer", () => {
    // A held sequence stalls everything behind it, so the hold has to be
    // bounded. On overflow the bytes go to the screen model rather than the
    // bit bucket: a garbled frame is recoverable, eaten output is not.
    test("releases held bytes instead of holding forever", () => {
      const junk = INTRODUCER_PLUS("x".repeat(MAX_PENDING + 10));
      const out = scanForGraphics("", junk);
      expect(out.pending).toBe("");
      expect(out.rest).toBe(junk);
      expect(out.relay).toBe("");
    });

    test("stays under the bound for a legitimate 4096-byte payload chunk", () => {
      const big = `\x1b_Ga=T,f=32,t=d,i=1,U=1,c=1,r=1,q=2,m=1;${"A".repeat(4096)}\x1b\\`;
      const out = scanForGraphics("", big);
      expect(out.relay).toBe(big);
      expect(out.rest).toBe("");
    });
  });
});

function INTRODUCER_PLUS(body: string): string {
  return `\x1b_G${body}`;
}

describe("PlacementTracker", () => {
  const T = (id: number, c: number, r: number, extra = "") =>
    `\x1b_Ga=T,f=32,t=f,i=${id},U=1,c=${c},r=${r},q=2${extra};bmFtZQ==\x1b\\`;
  const DEL = (id: number) => `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;

  test("passes a first transmit through untouched", () => {
    const t = new PlacementTracker();
    expect(t.normalise(T(7, 80, 24))).toBe(T(7, 80, 24));
  });

  test("passes an unchanged re-transmit through untouched", () => {
    // The steady state — 60 frames a second at the same size must not each
    // carry a delete.
    const t = new PlacementTracker();
    t.normalise(T(7, 80, 24));
    expect(t.normalise(T(7, 80, 24))).toBe(T(7, 80, 24));
  });

  test("deletes first when the placement grows", () => {
    // The bug this exists for: growing re-transmits under the same id with a
    // new c/r and no delete, where shrinking happens to delete first.
    const t = new PlacementTracker();
    t.normalise(T(7, 80, 24));
    expect(t.normalise(T(7, 120, 24))).toBe(DEL(7) + T(7, 120, 24));
  });

  test("deletes first when it shrinks too", () => {
    const t = new PlacementTracker();
    t.normalise(T(7, 120, 24));
    expect(t.normalise(T(7, 80, 24))).toBe(DEL(7) + T(7, 80, 24));
  });

  test("notices a row change, not just a column change", () => {
    const t = new PlacementTracker();
    t.normalise(T(7, 80, 24));
    expect(t.normalise(T(7, 80, 30))).toBe(DEL(7) + T(7, 80, 30));
  });

  test("tracks each image id separately", () => {
    // Two browser panes. One resizing must not disturb the other.
    const t = new PlacementTracker();
    t.normalise(T(7, 80, 24));
    t.normalise(T(9, 40, 24));
    expect(t.normalise(T(9, 60, 24))).toBe(DEL(9) + T(9, 60, 24));
    expect(t.normalise(T(7, 80, 24))).toBe(T(7, 80, 24));
  });

  test("a delete from the program resets the id, so the next transmit is a first", () => {
    const t = new PlacementTracker();
    t.normalise(T(7, 80, 24));
    t.normalise(DEL(7));
    expect(t.normalise(T(7, 120, 24))).toBe(T(7, 120, 24));
  });

  test("leaves cursor placements alone", () => {
    // No U=1: positioned by the cursor, so c/r are not its geometry.
    const cur = (c: number) => `\x1b_Ga=T,f=32,t=d,i=7,p=1,C=1,c=${c},r=2,q=2;AAA=\x1b\\`;
    const t = new PlacementTracker();
    t.normalise(cur(4));
    expect(t.normalise(cur(9))).toBe(cur(9));
  });

  test("passes continuation chunks straight through", () => {
    // Only the first chunk of a chunked transmit carries the keys; the rest
    // have no id and must not be mistaken for anything.
    const t = new PlacementTracker();
    const more = "\x1b_Gm=1;QUJD\x1b\\";
    expect(t.normalise(more)).toBe(more);
  });

  test("reset forgets everything", () => {
    const t = new PlacementTracker();
    t.normalise(T(7, 80, 24));
    t.reset();
    expect(t.normalise(T(7, 120, 24))).toBe(T(7, 120, 24));
  });
});
