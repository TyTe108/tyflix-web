// Thin RPC client for Transmission 4.1.2 (rpc-version 19). Talks to
// TRANSMISSION_URL + "/transmission/rpc" over plain HTTP with no credentials,
// using the legacy request form the deployed daemon still answers:
// POST {"method":"...","arguments":{...}}.
//
// Nothing constructs this client yet. It is ready to be injected the same way
// the other upstream clients are once a caller exists.
//
// Two non-obvious upstream behaviours live entirely in this file. First, a
// request with no valid X-Transmission-Session-Id is answered HTTP 409 with
// the correct token in that same header; the client caches the token and
// replays the identical request once. Second, RPC outcomes are signalled by
// the body's `result` field, not the HTTP status: a bad method is HTTP 200
// with result other than "success".
//
// A 200 whose body is not JSON (an HTML error page, a truncated payload) is
// wrapped as TransmissionUpstreamError with status 502, matching a transport
// failure: there is no usable upstream answer. listTorrents and getSessionStats
// also reject a success envelope that has no non-null `arguments` object.
// That check stays in those two wrappers. postRpc still returns
// body.arguments verbatim, including {}, which later mutations use.

/**
 * A failure reaching Transmission, whether it never answered, answered with a
 * non-2xx that is not a handshake 409, answered with a non-success `result`,
 * answered with a body that is not JSON, or answered success with no
 * `arguments` object on listTorrents / getSessionStats.
 *
 * `status` is Transmission's own code when there was a usable response, or
 * 502 when it never answered or the body could not be used. A timeout lands
 * in the 502 branch, since aborting makes fetch throw.
 */
export class TransmissionUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TransmissionUpstreamError";
    this.status = status;
  }
}

/** Options for createTransmissionClient. */
export type TransmissionClientOptions = {
  baseUrl: string; // TRANSMISSION_URL, trailing slash already stripped by config
};

const REQUEST_TIMEOUT_MS = 10_000;
const RPC_PATH = "/transmission/rpc";
const SESSION_HEADER = "X-Transmission-Session-Id";

type RpcPayload = {
  method: string;
  arguments?: { fields: string[] };
};

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Builds the Transmission RPC client. Exposes only listTorrents and
 * getSessionStats; start/stop/remove/session-set are later increments.
 *
 * @throws TransmissionUpstreamError from either method on handshake failure,
 * a non-success `result`, a non-2xx that is not a first-attempt 409, a
 * transport failure, a non-JSON body, a success with no `arguments` object,
 * or the 10 second timeout.
 */
export function createTransmissionClient(options: TransmissionClientOptions) {
  const { baseUrl } = options;
  // Cached from the most recent 409. Reused on later calls so a second RPC
  // after a successful first one is a single HTTP request, not another
  // handshake.
  let sessionId: string | undefined;

  /**
   * POSTs one RPC payload to /transmission/rpc and returns the parsed
   * `arguments` value as Transmission sent it, including an empty object.
   * Does not require `arguments` to be present: that rule belongs on
   * listTorrents and getSessionStats.
   *
   * @throws TransmissionUpstreamError on a 409 replay, a missing session
   * header, a non-2xx, a non-success `result`, a non-JSON body, a transport
   * failure, or timeout.
   */
  async function postRpc(
    payload: RpcPayload,
    isReplay: boolean,
  ): Promise<unknown> {
    // The timer is cleared in the finally below, which runs once fetch settles.
    // NOTE: that's before res.json() is read, so the timeout covers connecting
    // and headers but not a body that streams slowly.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${RPC_PATH}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(sessionId !== undefined ? { [SESSION_HEADER]: sessionId } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      // Catches both a dead daemon and our own abort, which arrives here as an
      // AbortError. Either way there's no upstream status to pass on.
      const message =
        err instanceof Error ? err.message : "Transmission request failed";
      throw new TransmissionUpstreamError(message, 502);
    } finally {
      // Runs on the success path too, so a fast response doesn't leave a live
      // timer behind.
      clearTimeout(timeout);
    }

    // Handshake: Transmission refuses a request with no valid session id with
    // HTTP 409 and puts the correct token in X-Transmission-Session-Id.
    // Cache it and replay this exact payload once. A 409 on that replay is
    // terminal. Do not retry a third time.
    if (res.status === 409) {
      if (isReplay) {
        throw new TransmissionUpstreamError(
          `Transmission ${RPC_PATH} failed (${res.status})`,
          res.status,
        );
      }
      const token = res.headers.get(SESSION_HEADER);
      if (token === null || token === "") {
        throw new TransmissionUpstreamError(
          `Transmission ${RPC_PATH} 409 missing ${SESSION_HEADER}`,
          res.status,
        );
      }
      sessionId = token;
      return postRpc(payload, true);
    }

    if (!res.ok) {
      throw new TransmissionUpstreamError(
        `Transmission ${RPC_PATH} failed (${res.status})`,
        res.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      // HTML from something in front of Transmission, or a truncated body.
      // There is no usable RPC answer, so this is the same 502 as a dead
      // fetch, not the 200 on the wire.
      const message =
        err instanceof Error ? err.message : "Transmission request failed";
      throw new TransmissionUpstreamError(message, 502);
    }

    if (!isNonNullObject(parsed)) {
      throw new TransmissionUpstreamError(
        "Transmission RPC body was not an object",
        502,
      );
    }

    const body = parsed as { arguments?: unknown; result?: unknown };

    // HTTP 200 is not success. Transmission puts the outcome in `result`;
    // anything other than the exact string "success" is a failure.
    if (body.result !== "success") {
      throw new TransmissionUpstreamError(
        `Transmission RPC failed: ${String(body.result)}`,
        res.status,
      );
    }

    return body.arguments;
  }

  /**
   * torrent-get for the given field names. Returns the parsed `arguments`
   * object (`{ torrents: [...] }`). An empty torrents array means no torrents,
   * not a failure. An empty arguments object is valid. A missing or non-object
   * arguments value is not.
   *
   * @throws TransmissionUpstreamError on handshake failure, a non-success
   * `result`, a non-2xx that is not a first-attempt 409, a transport failure,
   * a non-JSON body, a success with no non-null `arguments` object, or the
   * 10 second timeout.
   */
  async function listTorrents(fields: string[]): Promise<object> {
    const arguments_ = await postRpc(
      { method: "torrent-get", arguments: { fields } },
      false,
    );
    if (!isNonNullObject(arguments_)) {
      throw new TransmissionUpstreamError(
        "Transmission torrent-get returned no arguments object",
        502,
      );
    }
    return arguments_;
  }

  /**
   * session-stats. Returns the parsed `arguments` object. An empty object is
   * valid. A missing or non-object arguments value is not.
   *
   * @throws TransmissionUpstreamError on handshake failure, a non-success
   * `result`, a non-2xx that is not a first-attempt 409, a transport failure,
   * a non-JSON body, a success with no non-null `arguments` object, or the
   * 10 second timeout.
   */
  async function getSessionStats(): Promise<object> {
    const arguments_ = await postRpc({ method: "session-stats" }, false);
    if (!isNonNullObject(arguments_)) {
      throw new TransmissionUpstreamError(
        "Transmission session-stats returned no arguments object",
        502,
      );
    }
    return arguments_;
  }

  return { listTorrents, getSessionStats };
}

/**
 * The object returned by createTransmissionClient. Public surface is
 * listTorrents and getSessionStats only.
 */
export type TransmissionClient = ReturnType<typeof createTransmissionClient>;
