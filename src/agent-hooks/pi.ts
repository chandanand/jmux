import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { AgentState } from "../types";
import type { AgentIntegration, InstallKind, InstallOutcomeKind } from "./types";

/**
 * pi's integration surface is an in-process extension bus, not shell hooks, so
 * installing means dropping our extension file somewhere stable and adding its
 * path to pi's `settings.extensions` (the persisted form of `pi -e <path>`).
 */

function piSettingsPath(): string {
  return resolve(homedir(), ".pi", "agent", "settings.json");
}

/** Where the shipped extension is copied to. Stable across jmux upgrades. */
export function piExtensionTarget(): string {
  return resolve(
    process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"),
    "jmux",
    "pi-extension.ts",
  );
}

/** The extension source shipped inside the jmux package. */
function piExtensionSource(): string {
  return resolve(import.meta.dir, "pi-extension.ts");
}

interface PiSettings {
  extensions?: string[];
  [k: string]: unknown;
}

function readSettings(): PiSettings {
  const path = piSettingsPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as PiSettings;
}

function isRegistered(settings: PiSettings): boolean {
  return (settings.extensions ?? []).includes(piExtensionTarget());
}

export const piIntegration: AgentIntegration = {
  id: "pi",
  label: "pi",
  // No `waiting`: pi exposes no permission-request event to extensions, so that
  // state is unobservable rather than merely unimplemented.
  reports: new Set<AgentState>(["running", "complete"]),
  get configPath(): string {
    return piSettingsPath();
  },

  isPresent(): boolean {
    return existsSync(dirname(piSettingsPath())) || Bun.which("pi") !== null;
  },

  detect(): InstallKind {
    try {
      const registered = isRegistered(readSettings());
      if (!registered) return "none";
      // Registered but the file is gone, or is an older copy: pi would load
      // nothing, or the wrong thing. Either way it needs rewriting.
      if (!existsSync(piExtensionTarget())) return "partial";
      const shipped = readFileSync(piExtensionSource(), "utf-8");
      const installed = readFileSync(piExtensionTarget(), "utf-8");
      return shipped === installed ? "current" : "partial";
    } catch {
      return "none";
    }
  },

  install(): { kind: InstallOutcomeKind; notes: string[] } {
    if (piIntegration.detect() === "current") return { kind: "noop", notes: [] };

    const target = piExtensionTarget();
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(piExtensionSource(), target);

    const settings = readSettings();
    if (!isRegistered(settings)) {
      settings.extensions = [...(settings.extensions ?? []), target];
      mkdirSync(dirname(piSettingsPath()), { recursive: true });
      writeFileSync(piSettingsPath(), JSON.stringify(settings, null, 2) + "\n");
    }

    return {
      kind: "installed",
      notes: [
        "pi reports RUNNING and COMPLETE only — it exposes no permission event,",
        "so jmux never shows WAITING for a pi pane.",
      ],
    };
  },
};
