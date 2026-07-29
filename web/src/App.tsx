// The route table. Every URL the app answers is declared here and nowhere
// else, so this is the fastest way to get oriented in the frontend.
//
// Three tiers of access. /login and /request-access are public, because you
// need both of them before you have a session. Everything else nests inside
// <ProtectedRoute>, which bounces you to /login when there's no session, and
// then inside <AppShell>, which draws the persistent sidebar around whatever
// page renders. /admin stacks <AdminRoute> on top of that and checks the admin
// flag the server reported on /api/auth/me.
//
//   /login                         Plex PIN sign-in                    public
//   /request-access                "can I have an account" form        public
//   /                              redirect to /library
//   /home                          your watched-versus-requested numbers
//   /library, /library/:mediaType  browse the Plex sections
//   /discover                      TMDB trending, search, genre browse
//   /watchlist                     your Plex Watchlist
//   /requests                      your Seerr requests
//   /issues, /issues/:id           problems you reported on a title
//   /media/:type/:id               title page, :type is movie or tv
//   /person/:id                    a TMDB person and their credits
//   /collection/:id                a TMDB collection
//   /admin                         dashboard and queues          admin only
//
// The three /watch routes all render the same WatchPage. What separates them is
// which id the URL carries, and that decides which backend endpoint gets hit:
//
//   /watch/movie/:tmdbId        a TMDB id. The server asks Seerr for the
//                               matching Plex ratingKey before it can play.
//   /watch/episode/:ratingKey   a Plex episode ratingKey, taken straight from
//                               the episode list. No Seerr hop.
//   /watch/item/:itemRatingKey  a bare Plex ratingKey. This one exists for
//                               library movies that have no TMDB id at all,
//                               which the tmdbId route can't resolve.
//
// "/" redirects to /library, not /home, and the catch-all sends anything
// unmatched to "/" as well. That catch-all sits outside ProtectedRoute, so a
// stale bookmark from a logged-out browser still ends up at /login.

import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { AdminRoute, ProtectedRoute } from "./auth/ProtectedRoute";
import { AdminPage } from "./pages/AdminPage";
import { CollectionPage } from "./pages/CollectionPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { HomePage } from "./pages/HomePage";
import { IssueDetailPage } from "./pages/IssueDetailPage";
import { LibraryPage } from "./pages/LibraryPage";
import { LoginPage } from "./pages/LoginPage";
import { MediaDetailPage } from "./pages/MediaDetailPage";
import { MyIssuesPage } from "./pages/MyIssuesPage";
import { MyRequestsPage } from "./pages/MyRequestsPage";
import { PersonPage } from "./pages/PersonPage";
import { RequestAccessPage } from "./pages/RequestAccessPage";
import { WatchPage } from "./pages/WatchPage";
import { WatchlistPage } from "./pages/WatchlistPage";

/**
 * Declares every route in the app.
 *
 * Rendered by main.tsx inside BrowserRouter and AuthProvider, so anything below
 * here can read both router state and the current session.
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/request-access" element={<RequestAccessPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/library" replace />} />
          <Route path="/home" element={<HomePage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/library/:mediaType" element={<LibraryPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/watchlist" element={<WatchlistPage />} />
          <Route path="/requests" element={<MyRequestsPage />} />
          <Route path="/issues" element={<MyIssuesPage />} />
          <Route path="/issues/:id" element={<IssueDetailPage />} />
          <Route path="/media/:type/:id" element={<MediaDetailPage />} />
          <Route path="/watch/movie/:tmdbId" element={<WatchPage />} />
          <Route path="/watch/episode/:ratingKey" element={<WatchPage />} />
          <Route path="/watch/item/:itemRatingKey" element={<WatchPage />} />
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
