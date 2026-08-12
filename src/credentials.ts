// Where an adapter's token comes from.
//
// One resolver, used by every construction path. `jmux ctl` builds its own
// adapters (`cli/issue.ts`, `cli/workflow.ts`) and the adapters themselves read
// `process.env` internally, so a token stored only by jmux would work in the
// TUI and fail in the CLI — which is the whole implementation risk here.
//
// File first, environment second. The file is the more deliberate and more
// recent act: somebody typed it into jmux. The inverse silently masks the
// wizard's own final step with a years-old shell export, which is a wizard that
// lies on the one screen a new user is trusting.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";

export const DEFAULT_CREDENTIALS_PATH = resolve(
  homedir(),
  ".config",
  "jmux",
  "credentials.json",
);

/** Keyed by adapter type: `linear`, `github`, `gitlab`. */
export type CredentialStore = Record<string, string>;

export type CredentialSource = "file" | "env" | "none";

export interface ResolvedCredential {
  token: string | null;
  source: CredentialSource;
  /** True when both a stored and an environment token exist and differ. */
  shadowed: boolean;
}

/**
 * Read the stored credentials.
 *
 * A missing file is normal and yields `{}`. A corrupt one also yields `{}` — but
 * unlike the config, this is deliberately silent and non-fatal: a broken
 * credentials file must not stop jmux starting, because the environment may
 * still carry a perfectly good token and the adapter will report itself
 * unauthenticated in the ordinary way.
 */
export function readCredentials(path: string = DEFAULT_CREDENTIALS_PATH): CredentialStore {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: CredentialStore = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Store one adapter's token at mode 0600.
 *
 * Deliberately not `config.json`: that file is watched, rewritten on every
 * setting change, and is the one people paste into bug reports. Same secret,
 * much larger blast radius. Follows t3code, which keeps secrets as discrete
 * files under `userdata/secrets/` and never inline in settings.
 */
export function writeCredential(
  adapterType: string,
  token: string | null,
  path: string = DEFAULT_CREDENTIALS_PATH,
): void {
  const store = readCredentials(path);
  if (token === null || token.length === 0) delete store[adapterType];
  else store[adapterType] = token;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  // Explicit, because `mode` on writeFileSync only applies when the file is
  // *created* — an existing file written before this rule shipped would keep
  // whatever permissions it had.
  chmodSync(path, 0o600);
}

/**
 * The token an adapter should use, and where it came from.
 *
 * `shadowed` is the disclosure: when both sources exist and disagree, the row
 * says so rather than silently preferring one. It is not an error — the file
 * still wins — but a user who set an environment variable deserves to be told
 * it is not the one in use.
 */
export function resolveCredential(
  adapterType: string,
  envNames: readonly string[],
  opts: {
    store?: CredentialStore;
    env?: Record<string, string | undefined>;
  } = {},
): ResolvedCredential {
  const store = opts.store ?? readCredentials();
  const env = opts.env ?? process.env;

  const stored = store[adapterType] ?? null;
  let fromEnv: string | null = null;
  for (const name of envNames) {
    const v = env[name];
    if (v !== undefined && v.length > 0) { fromEnv = v; break; }
  }

  if (stored) {
    return { token: stored, source: "file", shadowed: fromEnv !== null && fromEnv !== stored };
  }
  if (fromEnv) return { token: fromEnv, source: "env", shadowed: false };
  return { token: null, source: "none", shadowed: false };
}
