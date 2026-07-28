import type { AgentKind } from "../types";
import { buildHookBlock, JMUX_HOOK_MARKER, LEGACY_HOOK_MARKER } from "./commands";
import type {
  HookEntry,
  HookEvent,
  HookSettings,
  InstallKind,
  InstallOutcome,
} from "./types";

/**
 * Pure transforms over the Claude-Code-shaped hooks document. Codex 0.145 uses
 * the identical schema — same PascalCase event keys, same
 * `{hooks: [{type, command, timeout}]}` entries — so both integrations share
 * this file and differ only in path and event set.
 *
 * Everything here is pure: callers own the file IO, which keeps the install
 * logic unit-testable without touching a real `~/.claude` or `~/.codex`.
 */

function isJmuxHookCommand(cmd: string): boolean {
  return cmd.includes(JMUX_HOOK_MARKER) || cmd.includes("@jmux-agent-kind");
}

function isLegacyHookCommand(cmd: string): boolean {
  return cmd.includes(LEGACY_HOOK_MARKER);
}

function hasJmuxHook(entries: HookEntry[] | undefined): boolean {
  return !!entries?.some((e) => e.hooks.some((h) => isJmuxHookCommand(h.command)));
}

/**
 * Whether the on-disk block matches what we would write *today*. A stale jmux
 * hook (right marker, wrong command text — e.g. a session-scoped emitter from
 * an older jmux) counts as `partial` so it gets rewritten rather than left to
 * report state into the wrong scope forever.
 */
export function detectInstalledKind(
  settings: HookSettings,
  kind: AgentKind,
  events: readonly HookEvent[],
): InstallKind {
  const hooks = settings.hooks ?? {};
  const legacyStop = hooks.Stop?.some((e) =>
    e.hooks.some((h) => isLegacyHookCommand(h.command)),
  );
  if (legacyStop) return "legacy";

  const block = buildHookBlock(kind, events);
  const present = events.filter((ev) => hasJmuxHook(hooks[ev]));
  if (present.length === 0) return "none";

  // Compare the whole hook entry, not just the command text. Timeout is part of
  // what we install (Codex caps SessionEnd at 3s and warns on every startup
  // above it), so ignoring it would leave existing installs stuck on stale
  // values while `--install-agent-hooks` cheerfully reports "already up to date".
  const matchesShipped = (ev: HookEvent): boolean => {
    const want = block[ev][0].hooks[0];
    return !!hooks[ev]?.some((e) =>
      e.hooks.some((h) => h.command === want.command && h.timeout === want.timeout),
    );
  };
  if (present.length === events.length && events.every(matchesShipped)) return "current";
  return "partial";
}

function stripLegacyAndJmux(entries: HookEntry[] | undefined): HookEntry[] {
  if (!entries) return [];
  return entries
    .map((e) => ({
      ...e,
      hooks: e.hooks.filter(
        (h) => !isJmuxHookCommand(h.command) && !isLegacyHookCommand(h.command),
      ),
    }))
    .filter((e) => e.hooks.length > 0);
}

export function installHooks(
  settings: HookSettings,
  kind: AgentKind,
  events: readonly HookEvent[],
): InstallOutcome {
  const detected = detectInstalledKind(settings, kind, events);
  if (detected === "current") {
    return {
      kind: "noop",
      settings: structuredClone(settings),
    };
  }

  // Deep-clone so callers can compare structurally and so we don't mutate the
  // caller's settings object.
  const next: HookSettings = structuredClone(settings);
  next.hooks ??= {};

  // For each managed event, strip any prior jmux/legacy entries and prepend
  // the canonical one. Preserves unrelated user entries.
  const block = buildHookBlock(kind, events);
  for (const event of events) {
    const existing = stripLegacyAndJmux(next.hooks[event]);
    next.hooks[event] = [...block[event], ...existing];
  }

  return {
    kind: detected === "legacy" ? "migrated" : "installed",
    settings: next,
  };
}
