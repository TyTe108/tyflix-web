// Browser entry point. index.html loads this one module, and it does two
// things: start the Google Cast sender SDK once for the page, then mount React
// inside the two providers everything downstream assumes are already there.
//
// The nesting is BrowserRouter, then AuthProvider, then App (the route table).
// AuthProvider fetches /api/auth/me the moment it mounts, so by the time a
// route renders, session status is either still "loading" or settled, and
// ProtectedRoute can gate on it in one place instead of every page checking.
//
// initCast() sits out here at module scope rather than in an effect because
// StrictMode double-invokes effects in development, and re-injecting the
// gstatic sender script is not something you want happening twice.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { initCast } from "./cast/initCast";
import "./styles.css";

// CAF sender: once per page lifetime (outside React so StrictMode remounts
// don't re-inject the gstatic script).
initCast();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
