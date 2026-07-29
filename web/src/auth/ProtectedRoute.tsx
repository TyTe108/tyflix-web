// The two route guards App.tsx wraps everything in. Both are layout routes:
// they render <Outlet /> when the check passes and something else when it
// doesn't, so no page component ever has to check auth itself.
//
// Neither of these is security. Authorization happens on the server, on every
// request, and an admin-only endpoint 403s whether or not the UI hid the link.
// These exist so people see the right thing, not so the wrong people can't
// reach the data.

import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "./AuthContext";

/**
 * Gate for everything that needs a session. Sends anonymous visitors to /login.
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
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

/**
 * Gate for /admin. Repeats ProtectedRoute's two checks rather than relying on
 * being nested inside it, then adds the admin one.
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
    return <Navigate to="/login" replace />;
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
