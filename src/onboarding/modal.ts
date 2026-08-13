import type { CellGrid } from "../types";
import type { Modal, ModalAction } from "../modal";
import type { InstallReport } from "../agent-hooks/registry";
import { InputModal } from "../input-modal";
import { OnboardingFlow } from "./flow";
import { renderFlow, type RenderExtras } from "./render";
import { INTENT_CHOICES } from "./pages";
import type { SetupStatus } from "./status";

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
  installAgents(): Promise<InstallReport[]>;
  addProjectDir(dir: string): Promise<void>;
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
  private child: InputModal | null = null;
  private termRows = 24;
  private reports: InstallReport[] = [];
  private busy: string | undefined;
  private mapIndex = 0;

  constructor(port: OnboardingPort) {
    this.port = port;
    this.flow = new OnboardingFlow(port.getStatus());
  }

  open(): void {
    this._open = true;
    this.flow = new OnboardingFlow(this.port.getStatus());
    this.child = null;
    this.reports = [];
    this.busy = undefined;
    this.mapIndex = 0;
  }

  close(): void {
    this._open = false;
    this.child = null;
  }

  isOpen(): boolean { return this._open; }

  /** Re-read the world without moving the cursor off its page. */
  refresh(): void { this.flow.setStatus(this.port.getStatus()); }

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

  private extras(): RenderExtras {
    return {
      reports: this.reports.length > 0 ? this.reports : undefined,
      projectDirs: this.port.getProjectDirs(),
      writeTargets: this.port.agentWriteTargets(),
      achievements: this.port.achievements(),
      busy: this.busy,
    };
  }

  // --- Test seams ---
  hasChild(): boolean { return this.child !== null; }
  childValue(): string { return this.child?.getValue() ?? ""; }
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
      const action = this.child.handleInput(data);
      if (action.type === "result") {
        const value = String(action.value ?? "");
        this.child = null;
        void this.commitChild(value);
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

    if (data === "\x1b[C") { this.flow.next(); return { type: "consumed" }; }
    if (data === "\x1b[D") { this.flow.back(); return { type: "consumed" }; }
    if (data === "\r") { void this.activate(); return { type: "consumed" }; }
    return { type: "consumed" };
  }

  private handleMapInput(data: string): ModalAction {
    const pages = this.flow.pages().filter((p) => p.step !== undefined);
    if (data === "\x1b") { this.close(); return { type: "closed" }; }
    if (data === "\x1b[A" || data === "k") {
      this.mapIndex = Math.max(0, this.mapIndex - 1);
      return { type: "consumed" };
    }
    if (data === "\x1b[B" || data === "j") {
      this.mapIndex = Math.min(Math.max(0, pages.length - 1), this.mapIndex + 1);
      return { type: "consumed" };
    }
    if (data === "\r") {
      const page = pages[this.mapIndex];
      if (page) this.flow.openStep(page.id);
      return { type: "consumed" };
    }
    return { type: "consumed" };
  }

  private async commitChild(value: string): Promise<void> {
    const page = this.flow.currentPage().id;
    if (!this.flow.beginAction()) return;
    this.busy = page === "tracker" ? "checking…" : "scanning…";
    this.port.onChange();
    try {
      if (page === "projects") await this.port.addProjectDir(value);
      else if (page === "tracker") await this.port.connectTracker(value);
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
      this.child = new InputModal({
        header: "Add a directory",
        subheader: "jmux will offer the repositories it finds underneath.",
        placeholder: "~/Code",
      });
      this.child.open();
      return;
    }

    if (page === "tracker") {
      this.child = new InputModal({
        header: "Paste your token",
        subheader: "Checked before it is saved. Stored in ~/.config/jmux/credentials.json, mode 0600.",
        secret: true,
      });
      this.child.open();
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
