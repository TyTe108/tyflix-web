// Picks the right Plex token to send to our own media server for a given user.
// Two lines of logic in their own file, because getting this wrong is the
// single worst bug this app has shipped: a shared account's plex.tv token and
// its token for this server are different strings, and sending the first one
// locked every shared user out at once. See sharedServerAccess.ts for the why.
//
// Call it anywhere a request goes to the PMS on a user's behalf.
// routes/library.ts imports it. routes/watch.ts has the same two lines inlined
// as a closure rather than importing this.

import type { SharedServerAccessResolver } from "./sharedServerAccess";

// Shared users need their per-server Plex token against our PMS; the owner
// isn't in that list, so fall back to the session's durable token.
/**
 * Resolves the token to use against our PMS for `plexId`.
 *
 * @param durableToken the plex.tv token decrypted out of the user's session
 * @returns the share's per-server access token, or `durableToken` unchanged
 * when `plexId` isn't a share. The second case is the owner's normal path, not
 * a failure.
 * @throws PlexSharedServerAccessError when the share list can't be read. It
 * throws rather than defaulting, because quietly falling back to the durable
 * token is exactly the broken behavior this function exists to prevent.
 */
export async function resolvePmsToken(
  sharedServerAccess: SharedServerAccessResolver,
  plexId: number,
  durableToken: string,
): Promise<string> {
  const shared = await sharedServerAccess.resolveAccessToken(plexId);
  return shared ?? durableToken;
}
