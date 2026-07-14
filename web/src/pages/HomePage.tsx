import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function HomePage() {
  const { user, isAdmin, logout } = useAuth();

  if (user === null) {
    return null;
  }

  return (
    <main className="page">
      <header className="row">
        <h1>Tyflix</h1>
        <button
          type="button"
          className="btn secondary"
          onClick={() => void logout()}
        >
          Logout
        </button>
      </header>

      <p>
        Signed in as <strong>{user.displayName}</strong>
        {isAdmin ? " (admin)" : " (member)"}.
      </p>

      {isAdmin ? (
        <p>
          <Link to="/admin">Admin</Link>
        </p>
      ) : null}
    </main>
  );
}
