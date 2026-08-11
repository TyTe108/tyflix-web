// A four-step wizard for people who want into the server but don't have
// access yet. Rendered at /request-access by App.tsx, outside ProtectedRoute
// and outside AppShell. /login is the app's other unauthenticated route, but it
// needs a Plex account already on the server to get anywhere, so this is the
// only page a stranger without an account can actually use.
//
// Two endpoints, both public: GET /api/config through useAccessRequestsEnabled
// to check the feature is on at all, and POST /api/access-requests through
// api/accessRequests.ts to submit. Nothing else. Approving a request happens
// on the admin page and is what actually calls Plex's sharing API.
//
// Being the only public write endpoint makes it the only thing anyone can
// abuse, so a couple of things here are deliberate. There's no CAPTCHA. The
// hidden `website` field is a honeypot that real browsers leave empty, and the
// server answers 202 to a honeypot trip, a duplicate email, and a genuine new
// request identically, so nothing about the response reveals who has already
// applied or which check caught you. A per-IP hourly cap handles the rest and
// surfaces here as the rateLimited branch.

import { useState } from "react";
import { Link } from "react-router";
import { submitAccessRequest } from "../api/accessRequests";
import { useAccessRequestsEnabled } from "../hooks/useAccessRequestsEnabled";

// Field caps, mirrored from the server's validator. These stop an obviously
// bad submit before it costs a round trip; the server enforces them for real.
const EMAIL_MAX = 254;
const NAME_MAX = 80;
const PLEX_USERNAME_MAX = 64;
const NOTE_MAX = 280;
// Shape check, not a validity check. Anything stricter rejects real addresses,
// and the only address that matters is the one Plex's invite reaches.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Step = 1 | 2 | 3 | 4;

/**
 * Self-serve access request form.
 *
 * Renders three different pages depending on state: a message when access
 * requests are switched off, the wizard, or the post-submit instructions.
 * Submitting is one-way. There's no going back to edit and resend.
 */
export function RequestAccessPage() {
  const accessRequestsEnabled = useAccessRequestsEnabled();
  const [step, setStep] = useState<Step>(1);
  const [hasPlexAccount, setHasPlexAccount] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [plexUsername, setPlexUsername] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  // The honeypot. Visually hidden and out of the tab order, so a person never
  // touches it and a form-filling bot usually does. Submitted verbatim.
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);

  // Wipes the last submit's error before anything changes. Every edit and
  // every step change calls this, so a stale "try again later" can't hang
  // around next to a form the user has since fixed.
  function clearSubmitFeedback() {
    setError(null);
    setRateLimited(false);
  }

  function goNext() {
    clearSubmitFeedback();
    setStep((s) => (s < 4 ? ((s + 1) as Step) : s));
  }

  function goBack() {
    clearSubmitFeedback();
    setStep((s) => (s > 1 ? ((s - 1) as Step) : s));
  }

  // Gates the Next and Submit buttons. Step 1 needs a yes or no, step 2 needs
  // a plausible email, step 3 needs both a name and a note, and step 4 is the
  // review so it's always valid on its own. Trimmed everywhere, because
  // whitespace-only input passes a `required` attribute.
  function stepValid(s: Step): boolean {
    if (s === 1) {
      return hasPlexAccount !== null;
    }
    if (s === 2) {
      const trimmed = email.trim();
      if (
        trimmed === "" ||
        trimmed.length > EMAIL_MAX ||
        !EMAIL_SHAPE.test(trimmed.toLowerCase())
      ) {
        return false;
      }
      if (hasPlexAccount === true && plexUsername.trim().length > PLEX_USERNAME_MAX) {
        return false;
      }
      return true;
    }
    if (s === 3) {
      const n = name.trim();
      const noteTrimmed = note.trim();
      return (
        n !== "" &&
        n.length <= NAME_MAX &&
        noteTrimmed !== "" &&
        noteTrimmed.length <= NOTE_MAX
      );
    }
    return true;
  }

  /**
   * Sends the request. The only network write this page makes.
   *
   * submitAccessRequest doesn't throw on 400 or 429, it returns a
   * discriminated result, so each failure gets its own inline treatment
   * instead of a generic catch. On success the whole wizard is replaced by
   * the instructions screen and there's no route back into the form.
   */
  async function handleSubmit() {
    if (hasPlexAccount === null || submitting) {
      return;
    }
    clearSubmitFeedback();
    setSubmitting(true);

    // Only send plexUsername when there's something to send. It's optional,
    // and step 1's No branch clears it anyway.
    const plexUser = plexUsername.trim();
    const result = await submitAccessRequest({
      email: email.trim(),
      name: name.trim(),
      note: note.trim(),
      hasPlexAccount,
      ...(hasPlexAccount && plexUser !== ""
        ? { plexUsername: plexUser }
        : {}),
      website,
    });

    setSubmitting(false);

    if (result.ok) {
      setSubmitted(true);
      return;
    }

    if (result.kind === "rateLimited") {
      setRateLimited(true);
      return;
    }

    if (result.kind === "validation") {
      setError(result.message);
      return;
    }

    setError(result.message);
  }

  // Feature gate. The hook returns null while the config probe is in flight,
  // so hold the page rather than flashing a form that might be switched off.
  if (accessRequestsEnabled === null) {
    return (
      <main className="page login request-access">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  // Requests turned off server-side. The route still resolves, since someone
  // may have the URL bookmarked, it just has nothing to submit to.
  if (accessRequestsEnabled === false) {
    return (
      <main className="page login request-access">
        <h1>Request access</h1>
        <div className="request-access-success">
          <p>
            Tyflix isn&rsquo;t accepting access requests right now. Try again
            later, or contact whoever runs this instance.
          </p>
        </div>
        <p>
          <Link to="/login" className="btn">
            Back to sign in
          </Link>
        </p>
      </main>
    );
  }

  // Post-submit. Worth being explicit about what happens next, because the
  // invitation arrives from Plex rather than from Tyflix and an unexpected
  // Plex email looks like phishing if nobody warned you.
  if (submitted) {
    return (
      <main className="page login request-access">
        <h1>Request received</h1>
        <div className="request-access-success">
          <p>
            Tyler reviews access requests manually. There&rsquo;s no automatic
            approval.
          </p>
          <p>
            If your request is approved, <strong>Plex</strong> will email you an
            invitation. Tyflix itself will not send you email.
          </p>
          <p>
            Click Accept in that invitation. If you don&rsquo;t already have a
            Plex account, you can create a free one when you accept.
          </p>
          <p>
            After that, come back here and sign in with Plex.
          </p>
        </div>
        <p>
          <Link to="/login" className="btn">
            Back to sign in
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="page login request-access">
      <h1>Request access</h1>
      <p className="muted request-access-progress">
        Step {step} of 4
      </p>

      {/* One form across all four steps, so Enter advances instead of
          submitting early. Only step 4 actually posts; the rest re-run their
          own validity check and move on. */}
      <form
        className="request-access-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (step < 4) {
            if (stepValid(step)) {
              goNext();
            }
            return;
          }
          void handleSubmit();
        }}
      >
        {/* The honeypot, standing in for a CAPTCHA. Hidden from sight and
            skipped by tabIndex -1, so anything in it came from a bot. Real
            people never see this and never get asked to prove anything. */}
        <label className="visually-hidden">
          Website
          <input
            type="text"
            name="website"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            tabIndex={-1}
            autoComplete="off"
          />
        </label>

        {/* Step 1. The answer is self-reported and only changes the wording on
            the next two steps, since Plex has no public "does this account
            exist" lookup. Answering No also clears any Plex username already
            typed, so it can't be submitted alongside hasPlexAccount false. */}
        {step === 1 ? (
          <fieldset className="request-access-step">
            <legend>Do you already have a Plex account?</legend>
            <p className="muted">
              Tyflix can&rsquo;t look this up for you. Plex doesn&rsquo;t expose
              an account check. Your answer only changes the instructions we show
              next.
            </p>
            <div className="request-access-choices" role="group">
              <button
                type="button"
                className={
                  hasPlexAccount === true
                    ? "request-choice selected"
                    : "request-choice"
                }
                onClick={() => {
                  clearSubmitFeedback();
                  setHasPlexAccount(true);
                }}
              >
                Yes
              </button>
              <button
                type="button"
                className={
                  hasPlexAccount === false
                    ? "request-choice selected"
                    : "request-choice"
                }
                onClick={() => {
                  clearSubmitFeedback();
                  setHasPlexAccount(false);
                  setPlexUsername("");
                }}
              >
                No
              </button>
            </div>
          </fieldset>
        ) : null}

        {/* Step 2. Email is the whole point of the form: it's what Plex's
            sharing API gets called with on approval. The Plex username field
            only appears for people who said Yes, and it's optional either
            way. */}
        {step === 2 ? (
          <fieldset className="request-access-step">
            <legend>Email</legend>
            {hasPlexAccount ? (
              <p className="muted">
                Use the email on your Plex account so the invitation reaches the
                right place. Plex username is optional but helps confirm
                it&rsquo;s you.
              </p>
            ) : (
              <p className="muted">
                You don&rsquo;t need a Plex account yet. If approved, Plex will
                email you an invitation. Accepting it is when you create a free
                Plex account, if you need one.
              </p>
            )}
            <label className="request-access-field">
              Email
              <input
                type="email"
                name="email"
                autoComplete="email"
                value={email}
                maxLength={EMAIL_MAX}
                onChange={(e) => {
                  clearSubmitFeedback();
                  setEmail(e.target.value);
                }}
                required
              />
            </label>
            {hasPlexAccount ? (
              <label className="request-access-field">
                Plex username{" "}
                <span className="muted">(optional)</span>
                <input
                  type="text"
                  name="plexUsername"
                  autoComplete="username"
                  value={plexUsername}
                  maxLength={PLEX_USERNAME_MAX}
                  onChange={(e) => {
                    clearSubmitFeedback();
                    setPlexUsername(e.target.value);
                  }}
                />
              </label>
            ) : null}
          </fieldset>
        ) : null}

        {/* Step 3. Both fields are required because approval is a manual call
            and there's nothing else to make it on. The note is the "how do I
            know you" line, which is why the placeholder is a relationship
            rather than a sales pitch. */}
        {step === 3 ? (
          <fieldset className="request-access-step">
            <legend>About you</legend>
            <p className="muted">
              A name and a short note on who you are, enough for Tyler to
              recognize the request.
            </p>
            <label className="request-access-field">
              Name
              <input
                type="text"
                name="name"
                autoComplete="name"
                value={name}
                maxLength={NAME_MAX}
                onChange={(e) => {
                  clearSubmitFeedback();
                  setName(e.target.value);
                }}
                required
              />
            </label>
            <label className="request-access-field">
              Note
              <input
                type="text"
                name="note"
                value={note}
                maxLength={NOTE_MAX}
                placeholder="e.g. Ewan's roommate"
                onChange={(e) => {
                  clearSubmitFeedback();
                  setNote(e.target.value);
                }}
                required
              />
            </label>
          </fieldset>
        ) : null}

        {/* Step 4. Read-only echo of exactly what handleSubmit will send,
            trimmed the same way, so nothing changes between what's shown here
            and what goes on the wire. */}
        {step === 4 ? (
          <fieldset className="request-access-step">
            <legend>Review</legend>
            <dl className="request-access-review">
              <div>
                <dt>Plex account</dt>
                <dd>{hasPlexAccount ? "Yes" : "No"}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{email.trim()}</dd>
              </div>
              {hasPlexAccount && plexUsername.trim() !== "" ? (
                <div>
                  <dt>Plex username</dt>
                  <dd>{plexUsername.trim()}</dd>
                </div>
              ) : null}
              <div>
                <dt>Name</dt>
                <dd>{name.trim()}</dd>
              </div>
              <div>
                <dt>Note</dt>
                <dd>{note.trim()}</dd>
              </div>
            </dl>
          </fieldset>
        ) : null}

        {/* 429 from the per-IP hourly cap. Split out from the generic error so
            the wording says "wait" rather than "something broke". */}
        {rateLimited ? (
          <p className="error" role="alert">
            You&rsquo;ve tried too many times. Please try again later.
          </p>
        ) : null}

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        {/* Nav row. Back turns into Cancel on step 1, and Next turns into
            Submit on step 4. Both right-hand buttons are type="submit" so the
            form's own handler decides which one they mean. */}
        <div className="request-access-actions">
          {step > 1 ? (
            <button
              type="button"
              className="btn secondary"
              onClick={goBack}
              disabled={submitting}
            >
              Back
            </button>
          ) : (
            <Link to="/login" className="btn secondary">
              Cancel
            </Link>
          )}
          {step < 4 ? (
            <button
              type="submit"
              className="btn"
              disabled={!stepValid(step)}
            >
              Next
            </button>
          ) : (
            <button
              type="submit"
              className="btn"
              disabled={submitting || !stepValid(4)}
            >
              {submitting ? "Submitting…" : "Submit"}
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
