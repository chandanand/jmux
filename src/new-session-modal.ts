import type { CellGrid } from "./types";
import { InputModal } from "./input-modal";
import { ListModal, type ListItem } from "./list-modal";
import type { ModalAction } from "./modal";

import { sanitizeTmuxSessionName } from "./config";
export { sanitizeTmuxSessionName };

export { tq } from "./shell-quote";

export interface NewSessionProviders {
  /**
   * Directories to start a session in, most relevant first.
   *
   * A `label` exists because two Projects may share one directory — a monorepo
   * serving two teams — and offering one row for both makes them
   * indistinguishable at the moment the user has to choose. The `dir` is still
   * what everything downstream consumes.
   */
  scanProjectDirs: () => NewSessionDir[];
  isBareRepo: (dir: string) => boolean;
  getWorktrees: (dir: string) => Array<{ name: string; path: string }>;
  getRemoteBranches: (dir: string) => string[];
  getDefaultBranch: (dir: string) => string;
}

/**
 * One directory choice in the first step.
 *
 * `projectId` distinguishes a configured Project from a bare path, and also
 * distinguishes two Projects that deliberately share one directory. The id
 * has to survive the picker: it is what the creator stamps onto the tmux
 * session so every later Project lookup is unambiguous.
 */
export interface NewSessionDir {
  dir: string;
  label?: string;
  projectId?: string;
}

export type NewSessionResult =
  | { type: "standard"; dir: string; name: string; projectId?: string }
  | { type: "existing_worktree"; dir: string; path: string; branch: string; projectId?: string }
  | { type: "new_worktree"; dir: string; baseBranch: string; name: string; projectId?: string };

type StepId = "dir" | "worktree" | "base_branch" | "name";

const NEW_WORKTREE_ID = "__new_worktree__";

interface StackEntry {
  modal: ListModal | InputModal;
  stepId: StepId;
}

export class NewSessionModal {
  private _open = false;
  private currentInner: ListModal | InputModal | null = null;
  private currentStep: StepId = "dir";
  private stepStack: StackEntry[] = [];
  private providers: NewSessionProviders;

  // Accumulated selections as we advance through steps
  private selectedDir = "";
  private selectedProjectId: string | undefined;
  private selectedBranch = "";
  private isBare = false;
  /** Opaque ListModal id -> the full choice it represents. */
  private dirChoices = new Map<string, NewSessionDir>();

  constructor(providers: NewSessionProviders) {
    this.providers = providers;
  }

  open(): void {
    this._open = true;
    this.stepStack = [];
    this.selectedDir = "";
    this.selectedProjectId = undefined;
    this.selectedBranch = "";
    this.isBare = false;
    this.currentStep = "dir";
    this.currentInner = this.createDirPicker();
    this.currentInner.open();
  }

  close(): void {
    this._open = false;
    this.currentInner?.close();
    this.currentInner = null;
    this.stepStack = [];
    this.selectedDir = "";
    this.selectedProjectId = undefined;
    this.selectedBranch = "";
    this.isBare = false;
  }

  isOpen(): boolean {
    return this._open;
  }

  preferredWidth(termCols: number): number {
    return Math.min(Math.max(40, Math.round(termCols * 0.55)), 80);
  }

  getCursorPosition(): { row: number; col: number } | null {
    return this.currentInner?.getCursorPosition() ?? null;
  }

  getGrid(width: number): CellGrid {
    return this.currentInner!.getGrid(width);
  }

  updateProjectDirs(dirs: NewSessionDir[]): void {
    if (!this._open) return;
    if (this.currentStep !== "dir") return;
    const inner = this.currentInner;
    if (!(inner instanceof ListModal)) return;
    const items = this.setDirChoices(dirs);
    inner.updateItems(items);
  }

  handleInput(data: string): ModalAction {
    // Intercept Esc before the inner modal sees it
    if (data === "\x1b") {
      if (this.stepStack.length > 0) {
        // Pop back to previous step
        const prev = this.stepStack.pop()!;
        this.currentInner = prev.modal;
        this.currentStep = prev.stepId;
        // Restore accumulated state based on what step we're returning to
        if (prev.stepId === "dir") {
          this.selectedDir = "";
          this.selectedProjectId = undefined;
          this.isBare = false;
        } else if (prev.stepId === "worktree") {
          this.selectedBranch = "";
        }
        return { type: "consumed" };
      }
      // At root step — close the wizard
      this.close();
      return { type: "closed" };
    }

    // Delegate all other input to the inner modal
    const action = this.currentInner!.handleInput(data);

    if (action.type === "result") {
      return this.advanceStep(action.value);
    }

    // If inner modal closed itself (shouldn't happen since we intercept Esc),
    // treat it as consumed
    if (action.type === "closed") {
      return { type: "consumed" };
    }

    return action;
  }

  private advanceStep(value: unknown): ModalAction {
    switch (this.currentStep) {
      case "dir": {
        const item = value as ListItem;
        const choice = this.dirChoices.get(item.id);
        if (!choice) return { type: "consumed" };
        this.selectedDir = choice.dir;
        this.selectedProjectId = choice.projectId;
        this.isBare = this.providers.isBareRepo(this.selectedDir);

        if (this.isBare) {
          // Push current to stack, show worktree picker
          this.pushCurrentToStack();
          this.currentStep = "worktree";
          this.currentInner = this.createWorktreePicker();
          this.currentInner.open();
          return { type: "consumed" };
        }

        // Non-bare: advance to name input
        this.pushCurrentToStack();
        this.currentStep = "name";
        const basename = this.selectedDir.split("/").pop() ?? "";
        const defaultName = sanitizeTmuxSessionName(basename);
        this.currentInner = this.createNameInput(defaultName);
        this.currentInner.open();
        return { type: "consumed" };
      }

      case "worktree": {
        const item = value as ListItem;
        if (item.id === NEW_WORKTREE_ID) {
          // New worktree flow: show branch picker
          this.pushCurrentToStack();
          this.currentStep = "base_branch";
          this.currentInner = this.createBranchPicker();
          this.currentInner.open();
          return { type: "consumed" };
        }

        // Existing worktree selected — find path
        const worktrees = this.providers.getWorktrees(this.selectedDir);
        const wt = worktrees.find(w => w.name === item.id);
        const result: NewSessionResult = {
          type: "existing_worktree",
          dir: this.selectedDir,
          path: wt?.path ?? "",
          branch: item.id,
          ...(this.selectedProjectId ? { projectId: this.selectedProjectId } : {}),
        };
        this.close();
        return { type: "result", value: result };
      }

      case "base_branch": {
        const item = value as ListItem;
        this.selectedBranch = item.id;

        this.pushCurrentToStack();
        this.currentStep = "name";
        this.currentInner = this.createNameInput("");
        this.currentInner.open();
        return { type: "consumed" };
      }

      case "name": {
        const name = value as string;
        if (this.isBare && this.selectedBranch) {
          const result: NewSessionResult = {
            type: "new_worktree",
            dir: this.selectedDir,
            baseBranch: this.selectedBranch,
            name,
            ...(this.selectedProjectId ? { projectId: this.selectedProjectId } : {}),
          };
          this.close();
          return { type: "result", value: result };
        }

        const result: NewSessionResult = {
          type: "standard",
          dir: this.selectedDir,
          name,
          ...(this.selectedProjectId ? { projectId: this.selectedProjectId } : {}),
        };
        this.close();
        return { type: "result", value: result };
      }
    }

    return { type: "consumed" };
  }

  private pushCurrentToStack(): void {
    if (this.currentInner) {
      this.stepStack.push({
        modal: this.currentInner,
        stepId: this.currentStep,
      });
    }
  }

  private breadcrumb(): string {
    const parts: string[] = [];
    if (this.selectedDir) {
      parts.push(this.shortenPath(this.selectedDir));
    }
    if (this.isBare && this.currentStep !== "worktree") {
      if (this.selectedBranch) {
        parts.push(`new worktree from ${this.selectedBranch}`);
      } else {
        parts.push("worktree");
      }
    }
    return parts.length > 0 ? parts.join(" > ") : "Pick a directory";
  }

  private shortenPath(dir: string): string {
    const home = typeof process !== "undefined" ? process.env.HOME ?? "" : "";
    if (home && dir.startsWith(home)) {
      return "~" + dir.slice(home.length);
    }
    return dir;
  }

  private createDirPicker(): ListModal {
    const dirs = this.providers.scanProjectDirs();
    const items = this.setDirChoices(dirs);
    return new ListModal({
      header: "New Session",
      subheader: "Pick a directory",
      items,
    });
  }

  /**
   * Give each first-step row a unique opaque id while retaining its Project
   * identity. A path cannot be the list id: two Projects may share it.
   */
  private setDirChoices(dirs: NewSessionDir[]): ListItem[] {
    this.dirChoices.clear();
    return dirs.map((choice, index) => {
      const id = `dir-choice:${index}`;
      this.dirChoices.set(id, choice);
      return {
        id,
        label: choice.label ?? this.shortenPath(choice.dir),
      };
    });
  }

  private createWorktreePicker(): ListModal {
    const worktrees = this.providers.getWorktrees(this.selectedDir);
    const items: ListItem[] = [
      { id: NEW_WORKTREE_ID, label: "+ new worktree" },
      ...worktrees.map(wt => ({ id: wt.name, label: wt.name })),
    ];
    const projectName = this.selectedDir.split("/").pop() ?? "";
    return new ListModal({
      header: "New Session",
      subheader: this.breadcrumb(),
      items,
    });
  }

  private createBranchPicker(): ListModal {
    const branches = this.providers.getRemoteBranches(this.selectedDir);
    const defaultBranch = this.providers.getDefaultBranch(this.selectedDir);
    const items: ListItem[] = branches.map(b => ({ id: b, label: b }));
    return new ListModal({
      header: "New Session",
      subheader: this.breadcrumb(),
      items,
      defaultQuery: defaultBranch,
    });
  }

  private createNameInput(defaultName: string): InputModal {
    return new InputModal({
      header: "New Session",
      subheader: this.breadcrumb(),
      value: defaultName,
      placeholder: "session name",
    });
  }
}
