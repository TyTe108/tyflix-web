// Account settings. Rendered at /settings by App.tsx, inside ProtectedRoute
// and AppShell. One nav entry on desktop (between My Issues and Admin) and in
// the mobile More sheet — not a bottom tab.
//
// Saves are immediate: there is no Save button and no local batch. On toggle,
// I write the clicked value into AuthContext right away so the controlled
// checkbox moves (and every other useAuth() consumer briefly sees it too). That
// write is unconfirmed. Then I PATCH /api/me/preferences. On success I
// reconcile AuthContext from the server's reply, which is the value that sticks.
// On failure I revert AuthContext to the previous value and show a fixed error
// next to the switch so the UI never rests on a value the server rejected.

import { useState } from "react";
import { updatePreferences } from "../api/me";
import { useAuth } from "../auth/AuthContext";

/**
 * Signed-in user's account settings. Today only Playback / fullscreen-on-Play.
 */
export function SettingsPage() {
  const { preferences, setPreferences } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFullscreenChange(checked: boolean) {
    const previous = preferences;
    setError(null);
    setPreferences({ ...preferences, fullscreenOnPlay: checked });
    setSaving(true);
    try {
      const next = await updatePreferences({ fullscreenOnPlay: checked });
      setPreferences(next);
    } catch (err: unknown) {
      setPreferences(previous);
      console.error(err);
      setError("Couldn't save that setting. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="page page-wide settings-page">
      <h1>Settings</h1>

      <section className="settings-section" aria-labelledby="settings-playback">
        <h2 id="settings-playback">Playback</h2>
        <p className="settings-section-copy">
          Turn this off to keep the player in the page, which is handy if you
          want it running in a window while you do something else.
        </p>

        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <span className="settings-toggle-text">
              Go fullscreen when I press Play
            </span>
            <input
              type="checkbox"
              checked={preferences.fullscreenOnPlay}
              disabled={saving}
              onChange={(event) => {
                void onFullscreenChange(event.target.checked);
              }}
            />
          </label>
          {error !== null ? (
            <p className="settings-toggle-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
