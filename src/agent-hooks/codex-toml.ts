/**
 * Codex gates its hook engine behind `[features] hooks = true` in
 * `~/.codex/config.toml`. jmux has to be able to turn that on, but config.toml
 * is the user's file and there is no TOML *writer* available — only a parser.
 *
 * So the edit is textual and then verified: we splice one line in, re-parse the
 * result, and require that (a) the flag is now true and (b) nothing else in the
 * document changed. Anything short of that returns `unsafe` and the caller
 * prints instructions instead of writing. That keeps a malformed config.toml
 * off disk regardless of what the hand-rolled splice does to an exotic file.
 */

export type FeatureFlagStatus =
  | "already-enabled"
  | "enabled"
  /** The user set `hooks = false` explicitly — reported, never overridden. */
  | "explicitly-disabled"
  /** The splice could not be verified; caller must fall back to instructions. */
  | "unsafe";

export interface FeatureFlagResult {
  status: FeatureFlagStatus;
  /** Text to write. Only differs from the input when status is "enabled". */
  text: string;
}

/** Matches a bare `[features]` table header, not `[features.sub]`. */
const FEATURES_HEADER = /^[ \t]*\[features\][ \t]*$/;

function parse(text: string): Record<string, unknown> | null {
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Order-independent serialisation for comparing two parsed TOML documents.
 *
 * Note this deliberately does NOT use `JSON.stringify(v, Object.keys(v).sort())`.
 * That second argument is a property *allowlist* applied at every depth, not a
 * key sorter — so every nested key absent from the top-level list is silently
 * dropped, and two documents differing only in nested values compare equal.
 * A guard that cannot see nested changes is worse than no guard, because it
 * reads as protection.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/**
 * Deep structural equality over parsed TOML, ignoring only `features.hooks`.
 * Used to prove the splice changed nothing but the one flag before we overwrite
 * the user's config.
 */
function sameExceptHooksFlag(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  const strip = (v: Record<string, unknown>): string => {
    const clone = structuredClone(v) as Record<string, unknown>;
    const features = clone.features;
    if (features && typeof features === "object") {
      delete (features as Record<string, unknown>).hooks;
      if (Object.keys(features as object).length === 0) delete clone.features;
    }
    return canonical(clone);
  };
  return strip(before) === strip(after);
}

export function ensureHooksFeature(text: string): FeatureFlagResult {
  const before = parse(text);
  if (before === null) return { status: "unsafe", text };

  const features = before.features;
  if (features && typeof features === "object") {
    const flag = (features as Record<string, unknown>).hooks;
    if (flag === true) return { status: "already-enabled", text };
    if (flag === false) return { status: "explicitly-disabled", text };
  }

  const lines = text.split("\n");
  const headerAt = lines.findIndex((l) => FEATURES_HEADER.test(l));

  const next =
    headerAt >= 0
      ? [...lines.slice(0, headerAt + 1), "hooks = true", ...lines.slice(headerAt + 1)]
      : [...lines, "", "[features]", "hooks = true", ""];

  const candidate = next.join("\n");
  const after = parse(candidate);
  if (after === null) return { status: "unsafe", text };
  const enabled = (after.features as Record<string, unknown> | undefined)?.hooks;
  if (enabled !== true) return { status: "unsafe", text };
  if (!sameExceptHooksFlag(before, after)) return { status: "unsafe", text };

  return { status: "enabled", text: candidate };
}
