import { useState } from "react";
import { Link } from "react-router-dom";
import { submitAccessRequest } from "../api/accessRequests";
import { useAccessRequestsEnabled } from "../hooks/useAccessRequestsEnabled";

const EMAIL_MAX = 254;
const NAME_MAX = 80;
const PLEX_USERNAME_MAX = 64;
const NOTE_MAX = 280;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Step = 1 | 2 | 3 | 4;

export function RequestAccessPage() {
  const accessRequestsEnabled = useAccessRequestsEnabled();
  const [step, setStep] = useState<Step>(1);
  const [hasPlexAccount, setHasPlexAccount] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [plexUsername, setPlexUsername] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);

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

  async function handleSubmit() {
    if (hasPlexAccount === null || submitting) {
      return;
    }
    clearSubmitFeedback();
    setSubmitting(true);

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

  if (accessRequestsEnabled === null) {
    return (
      <main className="page login request-access">
        <p className="muted">Loading…</p>
      </main>
    );
  }

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
            invitation — Tyflix itself will not send you email.
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

        {step === 1 ? (
          <fieldset className="request-access-step">
            <legend>Do you already have a Plex account?</legend>
            <p className="muted">
              Tyflix can&rsquo;t look this up for you — Plex doesn&rsquo;t expose
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
                email you an invitation — accepting it is when you create a free
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

        {step === 3 ? (
          <fieldset className="request-access-step">
            <legend>About you</legend>
            <p className="muted">
              A name and a short note on who you are — enough for Tyler to
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
