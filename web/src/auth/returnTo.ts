// The page an anonymous visitor asked for, carried on the /login entry.
//
// ProtectedRoute and AdminRoute build it with returnToState when they send
// someone to /login. LoginPage reads it with resolveReturnTo for both of its
// exits. Nothing outside the app can set router state, and resolveReturnTo
// still checks the value: history state is untrusted. "/" is what "no return
// path" navigates to. A value that failed the check is not navigated to.

/**
 * Router state for the path the visitor asked for.
 *
 * Concatenates pathname, search and hash. Does not decide whether that
 * path is safe to open; resolveReturnTo does.
 */
export function returnToState(location: {
  pathname: string;
  search: string;
  hash: string;
}): { returnTo: string } {
  return {
    returnTo: `${location.pathname}${location.search}${location.hash}`,
  };
}

/**
 * The path to open after sign-in.
 *
 * Accepts a string that starts with exactly one "/" and whose path is not
 * /login or under it. Search and hash on an accepted path are kept. Missing
 * state, a non-string returnTo, another host, and /login all return "/".
 */
export function resolveReturnTo(state: unknown): string {
  if (typeof state !== "object" || state === null || !("returnTo" in state)) {
    return "/";
  }
  const returnTo = state.returnTo;
  if (typeof returnTo !== "string" || !isSafeReturnPath(returnTo)) {
    return "/";
  }
  return returnTo;
}

// A second "/" or a "\" is another host to a browser (`//evil`, `/\evil`).
// /login and anything under it would send a signed-in visitor back through
// this same redirect.
function isSafeReturnPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    return false;
  }
  const queryOrHash = path.search(/[?#]/);
  const pathname = queryOrHash === -1 ? path : path.slice(0, queryOrHash);
  if (pathname === "/login" || pathname.startsWith("/login/")) {
    return false;
  }
  return true;
}
