import type { CellGrid } from "../types";
import type { Modal, ModalAction } from "../modal";
import type { InstallReport } from "../agent-hooks/registry";
import { InputModal } from "../input-modal";
import { ListModal } from "../list-modal";
import { OnboardingFlow } from "./flow";
import { renderFlow, type RenderExtras } from "./render";
import { INTENT_CHOICES, MAP_STEPS } from "./pages";
import { deriveStatus, type SetupStatus } from "./status";

/**
 * A status describing a machine with nothing on it, used only between
 * construction and the first `open()`. Never rendered: `open()` replaces it.
 */
const EMPTY_STATUS: SetupStatus = deriveStatus({
  agentsPresent: [], agentsStale: [], skillCurrent: false,
  namingConfigured: false, namingDeclined: false, namingAvailable: [],
  trackerType: null, trackerAuthed: false, trackerDeclined: false,
  projectCount: 0, attachedTeamCount: 0, workflowTabCount: 0, hunkInstalled: false,
});

/**
 * Everything the flow needs from the world.
 *
 * Injected, so the modal itself knows nothing about config, adapters or tmux —
 * the same boundary `GhostPreviewPort` draws, and what makes every branch below
 * reachable in a test.
 */
export interface OnboardingPort {
  getStatus(): SetupStatus;
  /** Directories already configured, shown on the projects page. */
  getProjectDirs(): string[];
  /** Every file the agents page will write, from installer metadata. */
  agentWriteTargets(): string[];
  /** A path that exists on this machine, offered as the editable default. */
  suggestedProjectDir(): string;
  /** What the tracker step is actually connecting to, named on screen. */
  trackerName(): string;
  /** Naming commands that will actually run here, and the one in force. */
  namingOptions(): ReadonlyArray<{ id: string; label: string; note: string }>;
  namingChosen(): string;
  setNaming(id: string): void;
  installAgents(): Promise<InstallReport[]>;
  /** Rejections are returned, never toasted: see `notice` in the modal. */
  addProjectDir(dir: string): Promise<{ ok: boolean; message?: string }>;
  connectTracker(token: string): Promise<{ ok: boolean }>;
  seedWorkflow(): void;
  /** Close, and hand off to the flow that is good at making sessions. */
  finish(): void;
  /** Lines for the finish page. */
  achievements(): string[];
  /** Repaint, for work that lands after the keypress that started it. */
  onChange(): void;
}

/**
 * The onboarding flow, as one composite modal.
 *
 * It owns its child collectors directly rather than calling `openModal()`, and
 * that is the whole reason the flow can take a token or a path without
 * destroying itself: `activeModal` is a single slot, so a modal that opens
 * another modal is evicted by it — which is exactly why four of the old
 * checklist's eight steps abandoned the user in the settings screen.
 *
 * `NewSessionModal` established this pattern; this is the second instance of
 * it, not a new idea.
 */
export class OnboardingModal implements Modal {
  private _open = false;
  private flow: OnboardingFlow;
  private readonly port: OnboardingPort;
  private child: InputModal | ListModal | null = null;
  private termRows = 24;
  private reports: InstallReport[] = [];
  private busy: string | undefined;
  private mapIndex = 0;
  /**
   * The last rejection, shown on the page that caused it.
   *
   * It used to go through `showToast`, which lands in the *toolbar's* status
   * chip — the top of the screen, transient, and nowhere near the centred
   * modal the user is looking at. A refusal announced somewhere the user is
   * not looking is indistinguishable from the flow having hung, which is
   * exactly how it was reported.
   */
  private notice: string | undefined;
  /**
   * The port's answers, cached.
   *
   * `getGrid` runs on every frame, and `agentWriteTargets` stats each agent's
   * config while `achievements` re-reads the skill file and probes PATH. Asking
   * the port from inside the painter meant doing all of that at the render
   * loop's cadence — the exact cost the checklist this replaced documented
   * avoiding, for the same reason. Recomputed when something could have
   * changed it: open, an action resolving, and a config reload.
   */
  private cached: RenderExtras = {};

  /**
   * Deliberately does not ask the port for anything.
   *
   * Every getter on it touches the filesystem, and this is constructed whether
   * or not onboarding is ever opened — so asking here would put a handful of
   * stats and a file read on the boot path of every single start. `open()` is
   * where the world is first read.
   */
  constructor(port: OnboardingPort) {
    this.port = port;
    this.flow = new OnboardingFlow(EMPTY_STATUS);
  }

  open(): void {
    this._open = true;
    this.flow = new OnboardingFlow(this.port.getStatus());
    this.child = null;
    this.reports = [];
    this.busy = undefined;
    this.mapIndex = 0;
    this.recomputeExtras();
  }

  close(): void {
    this._open = false;
    this.child = null;
  }

  isOpen(): boolean { return this._open; }

  /**
   * Re-read the world without moving the cursor off its page.
   *
   * Called after an action resolves and from the config watcher: a reload can
   * add projects or workflow views while the flow is open, and a snapshot only
   * the flow refreshed would go stale under the user's own edit.
   */
  refresh(): void {
    this.flow.setStatus(this.port.getStatus());
    this.recomputeExtras();
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(56, Math.round(termCols * 0.72)), 88);
  }

  getCursorPosition(): { row: number; col: number } | null {
    return this.child ? this.child.getCursorPosition() : null;
  }

  /**
   * Opted in, so a window drag does not discard the flow.
   *
   * Every other modal is closed by SIGWINCH because it sizes itself at open and
   * has nothing worth preserving. This one has every step behind you and
   * possibly a half-typed token.
   */
  onResize(_cols: number, rows: number): void {
    this.termRows = rows;
  }

  getHeight(): number {
    return Math.max(12, Math.min(this.termRows - 6, 28));
  }

  getGrid(width: number): CellGrid {
    if (this.child) return this.child.getGrid(width);
    return renderFlow(this.flow, width, this.getHeight(), this.extras());
  }

  /** Re-ask the port. Never called from the painter — see `cached`. */
  private recomputeExtras(): void {
    this.cached = {
      projectDirs: this.port.getProjectDirs(),
      writeTargets: this.port.agentWriteTargets(),
      achievements: this.port.achievements(),
      namingOptions: this.port.namingOptions(),
      namingChosen: this.port.namingChosen(),
    };
  }

  /** The cached answers plus the two things that change without the world. */
  private extras(): RenderExtras {
    return {
      ...this.cached,
      reports: this.reports.length > 0 ? this.reports : undefined,
      busy: this.busy,
      mapIndex: this.mapIndex,
      notice: this.notice,
    };
  }

  // --- Test seams ---
  hasChild(): boolean { return this.child !== null; }
  childValue(): string {
    return this.child instanceof InputModal ? this.child.getValue() : "";
  }
  currentPageId(): string { return this.flow.currentPage().id; }
  view(): string { return this.flow.view(); }
  getReports(): InstallReport[] { return this.reports; }

  handleInput(data: string): ModalAction {
    // A live collector owns every key, exactly as NewSessionModal delegates to
    // its current inner modal. Esc pops the collector rather than closing the
    // flow — one step back, not all of them.
    if (this.child) {
      if (data === "\x1b") {
        this.child = null;
        return { type: "consumed" };
      }
      const wasList = this.child instanceof ListModal;
      const action = this.child.handleInput(data);
      if (action.type === "result") {
        this.child = null;
        if (wasList) {
          const picked = action.value as { id: string } | undefined;
          if (picked) { this.port.setNaming(picked.id); this.refresh(); }
        } else {
          void this.commitChild(String(action.value ?? ""));
        }
      } else if (action.type === "closed") {
        this.child = null;
      }
      return { type: "consumed" };
    }

    if (this.flow.view() === "map") return this.handleMapInput(data);

    if (data === "\x1b") {
      if (this.flow.zoomOut() === "close") {
        this.close();
        return { type: "closed" };
      }
      this.mapIndex = 0;
      return { type: "consumed" };
    }

    if (this.flow.currentPage().id === "welcome") {
      if (data === "\x1b[A" || data === "k") { this.flow.moveIntent(-1); return { type: "consumed" }; }
      if (data === "\x1b[B" || data === "j") { this.flow.moveIntent(1); return { type: "consumed" }; }
      if (data === "\r") {
        this.flow.chooseIntent(INTENT_CHOICES[this.flow.getIntentIndex()]!.id);
        return { type: "consumed" };
      }
      return { type: "consumed" };
    }

    if (data === "\x1b[C" || data === "l") { this.notice = undefined; this.flow.next(); return { type: "consumed" }; }
    if (data === "\x1b[D" || data === "h") { this.notice = undefined; this.flow.back(); return { type: "consumed" }; }
    if (data === "\r") { void this.activate(); return { type: "consumed" }; }
    return { type: "consumed" };
  }

  private handleMapInput(data: string): ModalAction {
    if (data === "\x1b") { this.close(); return { type: "closed" }; }
    // Bounded by the rows the map actually draws, not by the current arm's
    // page set: the map lists every step, so filtering here would leave rows
    // on screen the cursor could never reach.
    const last = MAP_STEPS.length - 1;
    if (data === "\x1b[A" || data === "k") {
      this.mapIndex = Math.max(0, this.mapIndex - 1);
      return { type: "consumed" };
    }
    if (data === "\x1b[B" || data === "j") {
      this.mapIndex = Math.min(last, this.mapIndex + 1);
      return { type: "consumed" };
    }
    if (data === "\r") {
      const id = MAP_STEPS[this.mapIndex];
      if (id) this.flow.openStep(id);
      return { type: "consumed" };
    }
    return { type: "consumed" };
  }

  private async commitChild(value: string): Promise<void> {
    const page = this.flow.currentPage().id;
    if (!this.flow.beginAction()) return;
    this.busy = page === "tracker" ? "checking…" : "scanning…";
    this.notice = undefined;
    this.port.onChange();
    try {
      if (page === "projects") {
        const result = await this.port.addProjectDir(value);
        if (!result.ok) this.notice = result.message ?? `Could not add ${value}`;
      } else if (page === "tracker") {
        const result = await this.port.connectTracker(value);
        if (!result.ok) this.notice = "That token was rejected — nothing was changed";
      }
    } finally {
      this.busy = undefined;
      this.flow.endAction();
      this.refresh();
      this.port.onChange();
    }
  }

  private async activate(): Promise<void> {
    const page = this.flow.currentPage().id;

    if (page === "projects") {
      // A real value, not a placeholder. Dim hint text sitting where the value
      // goes reads as a filled field, so Enter looks like it should work — and
      // an empty commit is silently refused, so the flow looks hung.
      this.child = new InputModal({
        header: "Add a directory",
        subheader: "jmux will offer the repositories it finds underneath.",
        requiredHint: "Type a path, or press esc to skip this step.",
        value: this.port.suggestedProjectDir(),
      });
      this.child.open();
      return;
    }

    if (page === "tracker") {
      this.child = new InputModal({
        header: `Paste your ${this.port.trackerName()} API key`,
        subheader: "Checked before it is saved. Stored in ~/.config/jmux/credentials.json, mode 0600.",
        requiredHint: "Paste a key, or press esc to skip this step.",
        secret: true,
      });
      this.child.open();
      return;
    }

    if (page === "naming") {
      const options = this.port.namingOptions();
      if (options.length === 0) return;
      const picker = new ListModal({
        header: "Name sessions with",
        subheader: "Runs once per session. Change it any time in Settings.",
        items: options.map((o) => ({ id: o.id, label: o.label })),
      });
      picker.open();
      this.child = picker;
      return;
    }

    if (page === "workflow") {
      this.port.seedWorkflow();
      this.refresh();
      return;
    }

    if (page === "done") {
      this.port.finish();
      this.close();
      return;
    }

    if (page === "agents") {
      // Refused rather than queued: a double press must not install twice.
      if (!this.flow.beginAction()) return;
      this.busy = "setting up…";
      this.port.onChange();
      try {
        this.reports = await this.port.installAgents();
      } finally {
        this.busy = undefined;
        this.flow.endAction();
        this.refresh();
        this.port.onChange();
      }
    }
  }
}
