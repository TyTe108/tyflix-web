// The client's entire view of the session. Mounted once in main.tsx, above the
// router's route table, so every page can ask who's signed in without doing its
// own fetch.
//
// The user's own Plex token transits their browser in memory during login only
// (see LoginPage + lib/plexOauth.ts), is posted once to the server, and after
// that the browser holds nothing but a signed httpOnly cookie it can't read
// from JavaScript. The only way this app can answer "who am I" is to ask the
// server. That's what refresh() does: one call to /api/auth/me, which the
// server answers straight out of the cookie with no upstream calls at all.
// Cheap enough to run on every page load.
//
// Status is a three-way, and the third value is the one that matters.
// "loading" is not a detail to skip past: treating it as anonymous would bounce
// a signed-in user to /login on every refresh, so ProtectedRoute holds the
// screen until it settles.
//
// There's no interceptor and no automatic re-auth. A 401 out of fetchMe comes
// back as null and drops the app to "anon", and ProtectedRoute redirects on the
// next render. A 401 from any other endpoint just throws inside whichever page
// made the call, and the session state here doesn't move. In practice the
// cookie either works for everything or has expired for everything, so that
// gap hasn't mattered.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  fetchMe,
  logoutRequest,
  type AuthUser,
} from "../api/auth";

// "loading" only means the first /api/auth/me hasn't come back yet. A later
// refresh() doesn't return to it, so the UI never flickers back to a spinner.
export type AuthStatus = "loading" | "authed" | "anon";

type AuthContextValue = {
  user: AuthUser | null;
  isAdmin: boolean; // decided server-side from Seerr's permission bits
  status: AuthStatus;
  refresh: () => Promise<void>; // re-read the session, e.g. right after login
  logout: () => Promise<void>;
};

// Null default so useAuth can tell "no provider above me" from "provider says
// nobody's signed in".
const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Holds the session and hands it down. Wraps the whole app in main.tsx.
 *
 * Kicks off one /api/auth/me on mount and exposes refresh() for its single
 * caller, LoginPage, which re-reads the session once a Plex login finishes.
 * logout() doesn't use it: it clears local state and deliberately never asks
 * the server again.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [status, setStatus] = useState<AuthStatus>("loading");

  // Re-reads the session from the cookie. Both failure shapes land in the same
  // place: fetchMe returning null (a clean 401) and fetchMe throwing (network
  // trouble, or a 5xx) both drop to "anon". Erring toward logged-out is the
  // safe direction, since the server re-checks every request anyway and a
  // wrongly-optimistic "authed" would just render pages that then 401.
  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      if (me === null) {
        setUser(null);
        setIsAdmin(false);
        setStatus("anon");
        return;
      }
      setUser(me.user);
      setIsAdmin(me.isAdmin);
      setStatus("authed");
    } catch {
      setUser(null);
      setIsAdmin(false);
      setStatus("anon");
    }
  }, []);

  // Clears local state in a finally block, so a failed logout call still logs
  // you out of the UI. The cookie may survive that case, but the server is the
  // one enforcing anything, and the alternative is a user stuck looking at a
  // signed-in shell they can't get out of.
  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      setUser(null);
      setIsAdmin(false);
      setStatus("anon");
    }
  }, []);

  // The one automatic session read, on mount. refresh is a stable useCallback
  // with no deps, so this fires once per page load and not again.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ user, isAdmin, status, refresh, logout }),
    [user, isAdmin, status, refresh, logout],
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

/**
 * Reads the session. The only supported way to get at it.
 *
 * @throws Error when called outside AuthProvider, which turns a silent null
 * user into an obvious mounting mistake.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
