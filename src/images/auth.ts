// src/images/auth.ts
//
// Which credential, if any, may be sent to fetch an image.
//
// Issue descriptions are attacker-adjacent text: anyone who can file or comment
// on an issue chooses the URLs jmux is about to request. So the rule is an
// allowlist keyed on the *host*, not on which tracker the issue came from — a
// Linear issue whose description points at `evil.example` gets no Linear key,
// and a host is matched by exact name or by a dotted suffix so that
// `gitlab.com.evil.net` is a different host from `gitlab.com` rather than a
// substring of it.
//
// Credentials also never travel over plain http, regardless of host.

/** Env lookup, injected so the policy is testable without touching process.env. */
export type Env = Record<string, string | undefined>;

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function firstSet(env: Env, names: readonly string[]): string | null {
  for (const n of names) {
    const v = env[n];
    if (v) return v;
  }
  return null;
}

/**
 * Headers to send with an image request, or `{}` when the host has no
 * associated credential — which is the common case, since most attachment URLs
 * are signed or public and need nothing.
 */
export function authHeadersFor(url: string, env: Env): Record<string, string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  if (parsed.protocol !== "https:") return {};
  const host = parsed.hostname.toLowerCase();

  if (hostMatches(host, "linear.app")) {
    const key = firstSet(env, ["LINEAR_API_KEY", "LINEAR_TOKEN"]);
    // Linear's upload URLs are private to the workspace and 403 without the
    // same key the adapter authenticates with.
    if (key) return { Authorization: key };
    return {};
  }

  if (hostMatches(host, "github.com") || hostMatches(host, "githubusercontent.com")) {
    const token = firstSet(env, ["GH_TOKEN", "GITHUB_TOKEN"]);
    if (token) return { Authorization: `Bearer ${token}` };
    return {};
  }

  const gitlabHost = (env.GITLAB_HOST ?? env.CI_SERVER_HOST ?? "gitlab.com")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (gitlabHost && hostMatches(host, gitlabHost)) {
    const token = firstSet(env, [
      "GITLAB_TOKEN",
      "GITLAB_PRIVATE_TOKEN",
      "GITLAB_PERSONAL_ACCESS_TOKEN",
    ]);
    if (token) return { "PRIVATE-TOKEN": token };
  }

  return {};
}

/** Whether jmux will even attempt to fetch this URL. */
export function isFetchableImageUrl(url: string): boolean {
  try {
    const p = new URL(url);
    return p.protocol === "https:" || p.protocol === "http:";
  } catch {
    return false;
  }
}
