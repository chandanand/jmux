// src/images/passthrough.ts
//
// Graphics drawn by programs running *inside* tmux, relayed out to the real
// terminal.
//
// This is the mirror image of the rest of `src/images/`. Everywhere else jmux
// is the author of the picture: it owns the ids, transmits the payload, and
// emits placements from its own finished composite. Here jmux is a courier for
// somebody else's picture — terminal-browser, yazi, imgcat, anything that
// speaks the kitty protocol from a pane.
//
// The reason a courier is enough, rather than jmux having to understand the
// image, is that under tmux those programs use *virtual placements*: the APC
// carries the pixels (or, far more often, a shared-memory name pointing at
// them) and says `U=1`, while the position comes from a grid of U+10EEEE
// placeholder cells written into the pane as ordinary text. Those cells travel
// the normal path — tmux screen, ScreenBridge, CellGrid, compositor — so
// scrolling, sidebar offset, clipping and occlusion all work on them with no
// image-specific code, exactly as they do for jmux's own `ImageMark`s. All this
// module has to do is make sure the payload reaches the terminal that will draw
// it.
//
// The APC itself cannot travel that path: @xterm/headless has no notion of the
// kitty protocol, so it is jmux's job to lift the sequence out of the byte
// stream and hand it to the real terminal.

/** APC introducer for the kitty graphics protocol. */
const INTRODUCER = "\x1b_G";

/**
 * How many bytes of an unterminated sequence to hold before giving up on it.
 *
 * A single APC is bounded by the protocol's 4096-byte payload chunk plus its
 * key/value header, so anything approaching this is not a graphics command that
 * merely split across reads — it is a stray introducer, and continuing to hold
 * would stall the pane's real output behind it forever. On overflow the held
 * bytes are released to the screen model rather than dropped: a garbled frame
 * is recoverable, silently eaten output is not.
 */
export const MAX_PENDING = 128 * 1024;

export interface GraphicsScan {
  /** Sequences to write to the real terminal, in arrival order. */
  relay: string;
  /** The chunk with those sequences removed, to feed the screen model. */
  rest: string;
  /** A sequence that started but has not terminated, to thread in next call. */
  pending: string;
}

/**
 * Split a chunk of PTY output into graphics sequences and everything else.
 *
 * Stateless in the same shape as `scanForImageProbe` and `forwardOsc52` — the
 * caller threads `pending` between calls, because tmux has no obligation to
 * deliver a sequence in one read and reliably doesn't under load.
 *
 * Matched sequences are *removed* from `rest` rather than merely copied out.
 * Leaving them in would mean betting that every future version of the headless
 * terminal keeps silently discarding an APC it does not implement; a parser
 * that instead fell back to ground state would print several kilobytes of
 * base64 into the grid. The screen model has no use for these bytes either way,
 * so removing them costs nothing and removes the bet.
 *
 * Only `ESC _ G` is claimed. Other APC strings belong to whoever else is
 * speaking and are passed through untouched.
 */
export function scanForGraphics(pending: string, chunk: string): GraphicsScan {
  const s = pending + chunk;

  // Overwhelmingly the common case: a pane produced ordinary output and there
  // is no graphics traffic at all. Cost one indexOf and a cheap tail check.
  if (s.indexOf(INTRODUCER) < 0) return tail("", "", s);

  let relay = "";
  let rest = "";
  let pos = 0;

  for (;;) {
    const start = s.indexOf(INTRODUCER, pos);
    if (start < 0) return tail(relay, rest, s.slice(pos));

    const end = terminatorAt(s, start + INTRODUCER.length);
    if (end < 0) {
      // Unterminated: hold from the introducer on, so the next chunk can
      // complete it. Text *before* the introducer is already whole and is
      // released now — holding it would stall the pane behind a sequence that
      // has nothing to do with it.
      const held = s.slice(start);
      if (held.length > MAX_PENDING) {
        return { relay, rest: rest + s.slice(pos), pending: "" };
      }
      return { relay, rest: rest + s.slice(pos, start), pending: held };
    }

    relay += s.slice(start, end);
    rest += s.slice(pos, start);
    pos = end;
  }
}

/** Keys of one APC, i.e. everything before the payload's `;`. */
function keysOf(seq: string): string {
  const body = seq.slice(INTRODUCER.length);
  const semi = body.indexOf(";");
  return semi < 0 ? body : body.slice(0, semi);
}

function keyValue(keys: string, name: string): string | null {
  const m = keys.match(new RegExp(`(?:^|,)${name}=([^,]*)`));
  return m ? m[1] : null;
}

/**
 * Makes a re-transmitted image adopt its new geometry.
 *
 * A program redefining a virtual placement sends `a=T` under an id it has used
 * before, with a new `c`/`r`. Whether the terminal re-resolves the placement
 * from that, or keeps the geometry it already had, is not something the
 * protocol pins down — and terminal-browser only finds out when it *shrinks*,
 * because shrinking happens to take a different path that deletes the image
 * first (`kitty_delete`, then `ESC[2J`, then re-transmit). Growing does not.
 * That is the whole difference between a resize that lands and one that leaves
 * the picture at its old size, and it is why the failure looks like it only
 * happens one way.
 *
 * jmux is the one relaying these, so it removes the difference: when an id's
 * geometry changes, it emits the same delete the shrink path would have. The
 * transmit follows immediately in the same write, so the image is never
 * actually absent — this costs a few bytes on resize and nothing at all
 * otherwise.
 */
export class PlacementTracker {
  private geometry = new Map<string, string>();

  /** Relay bytes, with a delete inserted ahead of any changed placement. */
  normalise(relay: string): string {
    if (!relay) return relay;
    let out = "";
    for (const seq of relay.match(/\x1b_G[^\x1b\x07]*(?:\x1b\\|\x07)/g) ?? []) {
      const keys = keysOf(seq);
      const id = keyValue(keys, "i");
      if (!id) { out += seq; continue; }

      // A delete of our own or theirs — either way the terminal no longer holds
      // geometry for this id, so the next transmit is a first one.
      if (keyValue(keys, "a") === "d") {
        this.geometry.delete(id);
        out += seq;
        continue;
      }

      // Only virtual placements carry geometry worth tracking; a cursor
      // placement is positioned by where the cursor is, not by c/r.
      const cols = keyValue(keys, "c");
      const rows = keyValue(keys, "r");
      if (keyValue(keys, "a") !== "T" || keyValue(keys, "U") !== "1" || !cols || !rows) {
        out += seq;
        continue;
      }

      const geom = `${cols}x${rows}`;
      const previous = this.geometry.get(id);
      if (previous !== undefined && previous !== geom) {
        out += `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
      }
      this.geometry.set(id, geom);
      out += seq;
    }
    return out;
  }

  /** Forget everything, for a terminal that has been reset out from under us. */
  reset(): void {
    this.geometry.clear();
  }
}

/**
 * Finish a scan whose remaining text contains no complete introducer.
 *
 * The introducer can itself be split across reads — `ESC` in one chunk, `_G` in
 * the next — and at 60fps that is a certainty rather than an edge case, so a
 * trailing fragment of it is held back to be reconsidered with the next chunk.
 *
 * Holding a lone `ESC` is safe here in a way it explicitly is not in
 * `scanForImageProbe`: this is tmux's *output*, not the user's input, so the
 * worst case is one frame's worth of latency on a sequence that turns out to be
 * an ordinary CSI. On stdin the same trick would swallow the Escape key.
 */
function tail(relay: string, rest: string, remainder: string): GraphicsScan {
  const held = danglingPrefixLen(remainder);
  if (held === 0) return { relay, rest: rest + remainder, pending: "" };
  return {
    relay,
    rest: rest + remainder.slice(0, remainder.length - held),
    pending: remainder.slice(remainder.length - held),
  };
}

/** Length of the trailing run of `s` that is a proper prefix of the introducer. */
function danglingPrefixLen(s: string): number {
  for (let n = Math.min(INTRODUCER.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(INTRODUCER.slice(0, n))) return n;
  }
  return 0;
}

/**
 * Index just past the terminator of an APC string starting at `from`, or -1 if
 * it has not arrived yet.
 *
 * Both terminators are accepted. ST (`ESC \`) is what the protocol specifies
 * and what every emitter in practice sends; BEL is accepted for the same reason
 * the OSC 52 path accepts it — terminals are lenient here, so a strict reader
 * would be the only component in the chain that refuses a sequence everything
 * else honours.
 */
function terminatorAt(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "\x07") return i + 1;
    if (c === "\x1b") {
      if (i + 1 >= s.length) return -1; // split mid-terminator — wait for more
      if (s[i + 1] === "\\") return i + 2;
    }
  }
  return -1;
}
