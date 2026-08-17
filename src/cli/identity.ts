import { LinearAdapter } from "../adapters/linear";
import type { AdapterAuthState, AdapterIdentity } from "../adapters/types";
import type { ParsedCtlArgs } from "../cli";

export interface IdentityInput {
  type: string;
  authState: AdapterAuthState;
  identity: AdapterIdentity | null;
}

export interface IdentityPayload {
  tracker: {
    type: string;
    authState: AdapterAuthState;
    account: string | null;
    organization: string | null;
  };
}

/**
 * Shaped separately from the command handler so the payload is testable without
 * constructing an adapter or touching the network.
 */
export function buildIdentityPayload(input: IdentityInput): IdentityPayload {
  return {
    tracker: {
      type: input.type,
      authState: input.authState,
      account: input.identity?.account ?? null,
      organization: input.identity?.organization ?? null,
    },
  };
}

/**
 * Reports auth state rather than gating on it, unlike `issue get`/`issue move`:
 * this command's whole purpose is telling a caller *whether* the tracker is
 * authenticated, so a failed or unauthenticated state is the answer, not an
 * error to throw past.
 */
export async function handleIdentity(_parsed: ParsedCtlArgs): Promise<IdentityPayload> {
  const adapter = new LinearAdapter({});
  await adapter.authenticate();
  return buildIdentityPayload({
    type: adapter.type,
    authState: adapter.authState,
    identity: adapter.identity,
  });
}
