// The two route guards App.tsx wraps everything in. Both are layout routes:
// they render <Outlet /> when the check passes and something else when it
// doesn't, so no page component ever has to check auth itself.
//
// Neither of these is security. Authorization happens on the server, on every
// request, and an admin-only endpoint 403s whether or not the UI hid the link.
// These exist so people see the right thing, not so the wrong people can't
// reach the data.

import { useMemo } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "./AuthContext";
import { returnToState } from "./returnTo";

/**
 * Gate for everything that needs a session. Sends anonymous visitors to /login.
 *
 * The redirect carries { returnTo } for the page they asked for, unless this
 * tab became anonymous through logout(). LoginPage checks that value before
 * navigating; this component only records it.
 *
 * The "loading" branch is the important one. The session read is async, so
 * without holding the screen here, every page refresh would flash the login
 * redirect before /api/auth/me came back.
 */
export function ProtectedRoute() {
  const { status } = useAuth();

  if (status === "loading") {
    return <p className="muted">Loading…</p>;
  }

  if (status === "anon") {
    return <AnonLoginRedirect />;
  }

  return <Outlet />;
}

// Both gates send anonymous visitors here. The state object is memoized
// because Navigate lists `state` in an effect dependency list, and a new
// object on each render would navigate again. suppressReturnTo leaves the
// state off entirely, rather than sending returnTo: undefined.
function AnonLoginRedirect() {
  const location = useLocation();
  const { suppressReturnTo } = useAuth();
  const state = useMemo(
    () => (suppressReturnTo ? undefined : returnToState(location)),
    [suppressReturnTo, location.pathname, location.search, location.hash],
  );

  return <Navigate to="/login" replace state={state} />;
}

/**
 * Gate for /admin. Repeats ProtectedRoute's two checks rather than relying on
 * being nested inside it, then adds the admin one. The anonymous branch
 * records returnTo the same way, so this still works when it isn't nested.
 *
 * A signed-in non-admin gets a message in place of the page, not a redirect.
 * Bouncing them somewhere else would look like the link was broken; telling
 * them they don't have permission is honest and stops the retry loop.
 */
export function AdminRoute() {
  const { status, isAdmin } = useAuth();

  if (status === "loading") {
    return <p className="muted">Loading…</p>;
  }

  if (status === "anon") {
    return <AnonLoginRedirect />;
  }

  if (!isAdmin) {
    return (
      <main className="page">
        <h1>Admins only</h1>
        <p className="muted">You don’t have permission to view this area.</p>
      </main>
    );
  }

  return <Outlet />;
}
