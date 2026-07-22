import type { SharedServerAccessResolver } from "./sharedServerAccess";

// Shared users need their per-server Plex token against our PMS; the owner
// isn't in that list, so fall back to the session's durable token.
export async function resolvePmsToken(
  sharedServerAccess: SharedServerAccessResolver,
  plexId: number,
  durableToken: string,
): Promise<string> {
  const shared = await sharedServerAccess.resolveAccessToken(plexId);
  return shared ?? durableToken;
}
