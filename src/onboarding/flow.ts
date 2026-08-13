import type { SetupStatus } from "./status";
import { pagesFor, INTENT_CHOICES, type Intent, type PageDef, type PageId } from "./pages";

export type FlowView = "page" | "map";

/**
 * Where the user is, and what the keys are allowed to do.
 *
 * Two rules keep it from trapping anyone.
 *
 * **`next()` never requires completion.** Blocking advance until a page is
 * satisfied is how a wizard becomes a hostage situation, and it is exactly what
 * would make "I don't have a tracker account today" unrecoverable. Anything may
 * be left unfinished; the map records it and the finish page names it.
 *
 * **`zoomOut()` is one gesture with one meaning.** From a page it goes to the
 * map, from the map it closes. Not two different escapes with a rule between
 * them that has to be remembered.
 */
export class OnboardingFlow {
  private status: SetupStatus;
  private intent: Intent | null = null;
  private index = 0;
  private _view: FlowView = "page";
  private busy = false;
  private intentIndex = 0;

  constructor(status: SetupStatus) {
    this.status = status;
  }

  /**
   * Re-read the world.
   *
   * The page *set* is re-derived, but the cursor stays on the page id it was
   * on rather than the index it was at: re-deriving an index would move the
   * user mid-read whenever a poll changed what was true.
   */
  setStatus(status: SetupStatus): void {
    const currentId = this.pages()[this.index]?.id;
    this.status = status;
    if (currentId) {
      const at = this.pages().findIndex((p) => p.id === currentId);
      if (at >= 0) this.index = at;
    }
    this.clamp();
  }

  getStatus(): SetupStatus { return this.status; }
  getIntent(): Intent | null { return this.intent; }
  view(): FlowView { return this._view; }
  isBusy(): boolean { return this.busy; }
  getIntentIndex(): number { return this.intentIndex; }

  moveIntent(delta: number): void {
    const n = INTENT_CHOICES.length;
    this.intentIndex = (this.intentIndex + delta + n) % n;
  }

  /** Welcome only, until an intent is chosen. */
  pages(): PageDef[] {
    return pagesFor(this.intent ?? "manual", this.status);
  }

  currentPage(): PageDef {
    return this.pages()[this.index] ?? this.pages()[0]!;
  }

  chooseIntent(intent: Intent): void {
    this.intent = intent;
    if (intent === "manual") {
      // Nothing configured and nothing claimed. The map is the honest landing
      // place — reachable, rather than a dead end that reads as a refusal.
      this._view = "map";
      this.index = 0;
      return;
    }
    this._view = "page";
    this.index = 1; // past welcome
    this.clamp();
  }

  next(): void {
    if (this.busy) return;
    if (this.index < this.pages().length - 1) this.index += 1;
  }

  back(): void {
    if (this.busy) return;
    // Stops at the first real page rather than returning to the intent
    // question: re-asking it would silently discard the answer behind you.
    const floor = this.intent ? 1 : 0;
    if (this.index > floor) this.index -= 1;
  }

  /** `esc`. Says what the caller should do. */
  zoomOut(): "map" | "close" {
    if (this._view === "page" && this.intent) {
      this._view = "map";
      return "map";
    }
    return "close";
  }

  /**
   * Open a step from the map.
   *
   * The map lists every step, including ones outside the current arm — that is
   * what makes it an overview rather than a second copy of the sequence. So
   * choosing one the current intent does not contain adopts the arm that does,
   * because picking "Connect an issue tracker" off the overview is a statement
   * that you want it. Anything else would draw a row that refuses to open.
   */
  openStep(id: PageId): void {
    if (!this.pages().some((p) => p.id === id)) {
      this.intent = "tracker";
    }
    const at = this.pages().findIndex((p) => p.id === id);
    if (at < 0) return;
    this.index = at;
    this._view = "page";
  }

  /**
   * `Step N of M`, or null on a page that is not a step.
   *
   * Welcome and Done are excluded, so the number promised on the welcome page
   * is the number the rail then counts down — the contradiction the old
   * header's `1/5 done` above eight rows had no way to avoid.
   */
  stepLabel(): string | null {
    const pages = this.pages();
    const counted = pages.filter((p) => p.counts);
    const here = pages[this.index];
    if (!here?.counts) return null;
    return `Step ${counted.indexOf(here) + 1} of ${counted.length}`;
  }

  /**
   * Claim this page's single async action.
   *
   * False means one is already running: a second Enter is ignored rather than
   * queued, so a double press cannot install twice or verify a token twice.
   */
  beginAction(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  endAction(): void { this.busy = false; }

  private clamp(): void {
    const max = this.pages().length - 1;
    if (this.index > max) this.index = Math.max(0, max);
    if (this.index < 0) this.index = 0;
  }
}
