// Stdin capture gate.
//
// jmux enters raw mode and resumes stdin early in startup (see main.ts), but the
// interactive input pipeline (InputRouter) isn't constructed until well after an
// `await performBoot`. Bun discards data that arrives on a resumed stream with no
// `data` listener, so a fast-replying terminal's OSC 11 background answer — sent
// in response to the startup query — was lost in that window, leaving chrome on
// the hardcoded dark fallback theme.
//
// StdinGate closes that window: a single listener is attached before the query,
// so nothing is dropped. The terminal background is resolved the instant its
// reply arrives (even before the pipeline is ready), while ordinary keystrokes
// are buffered and replayed in order once markReady() is called.

import { scanForOsc11, type RGB } from "./theme";
import { scanForImageProbe, type CellPixels } from "./images/kitty";

export interface ImageProbeResult {
  /** Non-null once the terminal has answered the graphics capability probe. */
  supported: boolean | null;
  /** Non-null once it has reported its cell geometry. */
  cellPx: CellPixels | null;
}

export interface StdinGateHooks {
  /** Called once, when the terminal's OSC 11 background reply is resolved. */
  onBackground: (rgb: RGB) => void;
  /** Forwarded input bytes (reply peeled off). Only called once ready. */
  onInput: (str: string) => void;
  /** Called for each terminal-graphics probe reply, while armed. */
  onImageProbe?: (result: ImageProbeResult) => void;
  /** Grid size, needed to divide a text-area pixel report into cells. */
  gridSize?: () => { cols: number; rows: number };
}

export class StdinGate {
  private pending = ""; // carry-over for an OSC 11 reply split across chunks
  private resolved = false;
  private ready = false;
  private queue: string[] = [];
  // Graphics-probe scanning is armed only around a probe, not permanently. The
  // scan holds a partial APC reply across chunks, and an unbounded hold on
  // input jmux might never receive again is not something to leave switched on
  // for the life of the process.
  private imageArmed = false;
  private imagePending = "";

  constructor(private readonly hooks: StdinGateHooks) {}

  /** Start peeling graphics-probe replies out of the stream. */
  armImageProbe(): void {
    this.imageArmed = true;
    this.imagePending = "";
  }

  /**
   * Stop scanning, releasing anything held mid-reply back into the input
   * stream — a terminal that started an APC and never finished it must not cost
   * the user the keystrokes that followed.
   */
  disarmImageProbe(): void {
    if (!this.imageArmed) return;
    this.imageArmed = false;
    const held = this.imagePending;
    this.imagePending = "";
    if (held.length > 0) this.emit(held);
  }

  /** Feed one raw stdin chunk. */
  feed(chunk: string): void {
    let str = chunk;
    if (!this.resolved) {
      const scan = scanForOsc11(this.pending, str);
      this.pending = scan.pending;
      if (scan.rgb) {
        this.resolved = true;
        this.hooks.onBackground(scan.rgb);
      }
      if (scan.forward === null) return; // holding a split reply
      str = scan.forward;
    }
    if (this.imageArmed) {
      const grid = this.hooks.gridSize?.() ?? { cols: 0, rows: 0 };
      const scan = scanForImageProbe(this.imagePending, str, grid);
      this.imagePending = scan.pending;
      if (scan.supported !== null || scan.cellPx !== null) {
        this.hooks.onImageProbe?.({ supported: scan.supported, cellPx: scan.cellPx });
      }
      if (scan.forward === null) return; // holding a split reply
      str = scan.forward;
    }
    this.emit(str);
  }

  private emit(str: string): void {
    if (str.length === 0) return;
    if (this.ready) {
      this.hooks.onInput(str);
    } else {
      this.queue.push(str);
    }
  }

  /**
   * Re-arm background detection so the next OSC 11 reply is captured again.
   * Used for live theme changes: jmux re-queries the terminal, and the reply
   * to that fresh query must be resolved even though one was already resolved
   * at startup. Discards any half-received split reply from the previous scan.
   */
  rearm(): void {
    this.resolved = false;
    this.pending = "";
  }

  /** Open the gate: flush buffered input and forward everything from now on. */
  markReady(): void {
    if (this.ready) return;
    this.ready = true;
    if (this.queue.length > 0) {
      const buffered = this.queue.join("");
      this.queue.length = 0;
      if (buffered.length > 0) this.hooks.onInput(buffered);
    }
  }
}
