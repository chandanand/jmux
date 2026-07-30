import { describe, expect, test } from "bun:test";
import { installHooks, uninstallHooks } from "../../agent-hooks/json-hooks";
import type { HookEvent, HookSettings } from "../../agent-hooks/types";

const EVENTS: readonly HookEvent[] = ["UserPromptSubmit", "Stop"];

const userHook = {
  hooks: [{ type: "command" as const, command: "echo mine", timeout: 5 }],
};

describe("uninstallHooks", () => {
  // The property that matters: install then uninstall must be a round trip.
  // Anything left behind keeps emitting state for a jmux that is gone.
  test("round-trips an install back to the original document", () => {
    const original: HookSettings = { model: "opus", hooks: { Stop: [userHook] } };
    const installed = installHooks(original, "claude", EVENTS).settings;
    const { removed, settings } = uninstallHooks(installed, EVENTS);

    expect(removed).toBe(true);
    expect(settings).toEqual(original);
  });

  test("preserves unrelated settings and unrelated hook entries", () => {
    const original: HookSettings = { theme: "dark", hooks: { Stop: [userHook] } };
    const installed = installHooks(original, "claude", EVENTS).settings;
    const { settings } = uninstallHooks(installed, EVENTS);

    expect(settings.theme).toBe("dark");
    expect(settings.hooks?.Stop).toEqual([userHook]);
  });

  // An emptied event left as `[]` would make an uninstalled config differ from
  // one jmux never touched, which is the difference between clean and "almost".
  test("deletes emptied events and an emptied hooks key", () => {
    const { settings } = uninstallHooks(installHooks({}, "claude", EVENTS).settings, EVENTS);
    expect(settings.hooks).toBeUndefined();
  });

  test("reports nothing removed when jmux was never installed", () => {
    const original: HookSettings = { hooks: { Stop: [userHook] } };
    const { removed, settings } = uninstallHooks(original, EVENTS);

    expect(removed).toBe(false);
    expect(settings).toEqual(original);
  });

  test("is pure — the input document is untouched", () => {
    const original: HookSettings = { hooks: { Stop: [userHook] } };
    const installed = installHooks(original, "claude", EVENTS).settings;
    const snapshot = structuredClone(installed);

    uninstallHooks(installed, EVENTS);

    expect(installed).toEqual(snapshot);
  });

  test("handles a document with no hooks key at all", () => {
    const { removed, settings } = uninstallHooks({ model: "opus" }, EVENTS);
    expect(removed).toBe(false);
    expect(settings).toEqual({ model: "opus" });
  });
});
