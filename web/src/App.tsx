import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { AdminRoute, ProtectedRoute } from "./auth/ProtectedRoute";
import { AdminPage } from "./pages/AdminPage";
import { CollectionPage } from "./pages/CollectionPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { HomePage } from "./pages/HomePage";
import { IssueDetailPage } from "./pages/IssueDetailPage";
import { LoginPage } from "./pages/LoginPage";
import { MediaDetailPage } from "./pages/MediaDetailPage";
import { MyIssuesPage } from "./pages/MyIssuesPage";
import { MyRequestsPage } from "./pages/MyRequestsPage";
import { PersonPage } from "./pages/PersonPage";
import { WatchPage } from "./pages/WatchPage";
import { WatchlistPage } from "./pages/WatchlistPage";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/watchlist" element={<WatchlistPage />} />
          <Route path="/requests" element={<MyRequestsPage />} />
          <Route path="/issues" element={<MyIssuesPage />} />
          <Route path="/issues/:id" element={<IssueDetailPage />} />
          <Route path="/media/:type/:id" element={<MediaDetailPage />} />
          <Route path="/watch/movie/:tmdbId" element={<WatchPage />} />
          <Route path="/person/:id" element={<PersonPage />} />
          <Route path="/collection/:id" element={<CollectionPage />} />
          <Route element={<AdminRoute />}>
            <Route path="/admin" element={<AdminPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
