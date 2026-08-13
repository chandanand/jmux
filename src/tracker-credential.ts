/**
 * Write a tracker credential, verify it, and put everything back exactly as it
 * was if it does not work.
 *
 * Three defects this exists to fix, all of them live in the setup checklist's
 * tracker step:
 *
 * **The rollback destroyed a working token.** It wrote `null` on failure, so
 * one mistyped paste over a connected setup left the user with no credential at
 * all — strictly worse than before they tried, and with nothing said about it.
 * The previous value is snapshotted and restored verbatim, and `null` is only
 * ever written back when `null` is what was there.
 *
 * **The adapter type was never persisted.** `createAdapters` builds nothing
 * without `adapters.issueTracker.type`, so a token stored against an unset type
 * connects to nothing and reports no reason. Type and token are committed
 * together, and only once the token is known to work — a type pointing at a
 * credential that does not work is a config that looks connected and is not.
 *
 * **Verification cannot precede the write.** `IssueTrackerAdapter` takes no
 * candidate credential and `LinearAdapter.authenticate()` reads the global
 * resolver, so there is nowhere to try a token without storing it first. This
 * is therefore write-verify-restore and says so plainly rather than claiming a
 * guarantee it does not deliver. The exposure is one round trip; the restore is
 * exact.
 *
 * Every dependency is injected so the rule is testable without a real
 * credentials file or a network.
 */

export interface TrackerCredentialOptions {
  /** The adapter type this token is for, e.g. `linear`. */
  type: string;
  token: string;
  readCredential: (type: string) => string | null;
  writeCredential: (type: string, token: string | null) => void;
  persistType: (type: string) => void;
  /** Make a real identity request against what is now on disk. */
  verify: () => Promise<boolean>;
}

export type TrackerCredentialResult = { ok: boolean };

export async function applyTrackerCredential(
  opts: TrackerCredentialOptions,
): Promise<TrackerCredentialResult> {
  const previous = opts.readCredential(opts.type);
  opts.writeCredential(opts.type, opts.token);

  let verified = false;
  try {
    verified = await opts.verify();
  } catch {
    // A verifier that throws is a rejection. Letting it escape would leave the
    // candidate on disk and the caller with no idea it was still there.
    verified = false;
  }

  if (!verified) {
    // Restore, never clear. `previous` may itself be null, which restores
    // absence — also exactly what was there before.
    opts.writeCredential(opts.type, previous);
    return { ok: false };
  }

  opts.persistType(opts.type);
  return { ok: true };
}
