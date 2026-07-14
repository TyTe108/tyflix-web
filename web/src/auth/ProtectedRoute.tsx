import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "./AuthContext";

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
