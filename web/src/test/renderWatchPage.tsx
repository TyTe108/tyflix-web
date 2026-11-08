// Renders WatchPage on the episode route with a made-up play descriptor.
//
// Hosts are example.plex.direct names, and the session id and token are
// placeholders. The app repo is public, so none of these are a real server,
// address, token, or rating key. The episode fetch stays pending until the
// test resolves it. The playback test stubs global fetch so a call that
// escapes the mock throws.
//
// Used by web/src/pages/WatchPage.playback.test.tsx.

import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { vi } from "vitest";
import {
  fetchEpisodeWatch,
  fetchItemWatch,
  fetchMovieWatch,
  fetchNextEpisode,
  fetchPreviousEpisode,
  reportTimeline,
  reportTimelineBeacon,
  selectAudio,
  selectSubtitle,
  type WatchDescriptor,
  type WatchTuning,
} from "../api/watch";
import { WatchPage } from "../pages/WatchPage";

const LOCAL_ORIGIN = "https://local.example.plex.direct:32400";
const REMOTE_ORIGIN = "https://remote.example.plex.direct:32400";
const DEFAULT_TOKEN = "example-token-56";
const DEFAULT_SESSION_ID = "session-example-1";
const DEFAULT_RATING_KEY = "900001";

type PendingEpisodeWatch = {
  ratingKey: string;
  tuning: WatchTuning | undefined;
  resolve: (descriptor: WatchDescriptor) => void;
  reject: (error: unknown) => void;
};

const pending: PendingEpisodeWatch[] = [];

/**
 * Options for buildWatchDescriptor. Omitted fields use the example episode.
 * local: null builds a descriptor whose hls.local is null.
 */
export type WatchDescriptorOptions = {
  ratingKey?: string;
  sessionId?: string;
  token?: string;
  viewOffsetMs?: number | null;
  local?: string | null;
};

function streamUrl(origin: string, sessionId: string, token: string): string {
  return `${origin}/video/:/transcode/universal/start.m3u8?session=${sessionId}&X-Plex-Token=${token}`;
}

/**
 * A WatchDescriptor for one made-up episode. durationMs is 7_200_000 and
 * viewOffsetMs is null unless the options set one. streams.audio and
 * streams.subtitle are empty.
 */
export function buildWatchDescriptor(
  options: WatchDescriptorOptions = {},
): WatchDescriptor {
  const ratingKey = options.ratingKey ?? DEFAULT_RATING_KEY;
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  const token = options.token ?? DEFAULT_TOKEN;
  const local =
    options.local === null
      ? null
      : (options.local ?? streamUrl(LOCAL_ORIGIN, sessionId, token));
  const remote = streamUrl(REMOTE_ORIGIN, sessionId, token);
  return {
    mediaType: "episode",
    ratingKey,
    connections: {
      local: local === null ? null : LOCAL_ORIGIN,
      remote: REMOTE_ORIGIN,
    },
    transient: token,
    hls: { local, remote },
    dash: {
      local: null,
      remote: `${REMOTE_ORIGIN}/dash/start.mpd?X-Plex-Token=${token}`,
    },
    dashDecision: {
      local: null,
      remote: `${REMOTE_ORIGIN}/video/:/transcode/universal/decision?X-Plex-Token=${token}`,
    },
    sessionId,
    streams: { audio: [], subtitle: [] },
    durationMs: 7_200_000,
    creditsOffsetMs: null,
    partId: null,
    title: "Example Picture",
    subheading: "S1E1 · Example",
    viewOffsetMs: options.viewOffsetMs ?? null,
  };
}

function requireMock(name: string, fn: unknown): void {
  if (!vi.isMockFunction(fn)) {
    throw new Error(`${name} is not mocked`);
  }
}

/**
 * Points the watch fetch mocks at a pending queue and makes the other
 * replaced watch calls resolve without a network request.
 * fetchItemWatch and fetchMovieWatch reject, because these tests use the
 * episode route.
 *
 * @throws Error when the watch functions are not mocks.
 */
export function installWatchFetchMocks(): void {
  requireMock("fetchEpisodeWatch", fetchEpisodeWatch);
  requireMock("fetchItemWatch", fetchItemWatch);
  requireMock("fetchMovieWatch", fetchMovieWatch);
  requireMock("fetchNextEpisode", fetchNextEpisode);
  requireMock("fetchPreviousEpisode", fetchPreviousEpisode);
  requireMock("selectSubtitle", selectSubtitle);
  requireMock("selectAudio", selectAudio);
  requireMock("reportTimeline", reportTimeline);
  requireMock("reportTimelineBeacon", reportTimelineBeacon);

  pending.length = 0;
  vi.mocked(fetchEpisodeWatch).mockReset();
  vi.mocked(fetchEpisodeWatch).mockImplementation((ratingKey, tuning) => {
    return new Promise((resolve, reject) => {
      pending.push({ ratingKey, tuning, resolve, reject });
    });
  });
  vi.mocked(fetchItemWatch).mockReset();
  vi.mocked(fetchItemWatch).mockRejectedValue(
    new Error("fetchItemWatch was not expected"),
  );
  vi.mocked(fetchMovieWatch).mockReset();
  vi.mocked(fetchMovieWatch).mockRejectedValue(
    new Error("fetchMovieWatch was not expected"),
  );
  vi.mocked(fetchNextEpisode).mockReset();
  vi.mocked(fetchNextEpisode).mockResolvedValue(null);
  vi.mocked(fetchPreviousEpisode).mockReset();
  vi.mocked(fetchPreviousEpisode).mockResolvedValue(null);
  vi.mocked(selectSubtitle).mockReset();
  vi.mocked(selectSubtitle).mockResolvedValue(undefined);
  vi.mocked(selectAudio).mockReset();
  vi.mocked(selectAudio).mockResolvedValue(undefined);
  vi.mocked(reportTimeline).mockReset();
  vi.mocked(reportTimelineBeacon).mockReset();
}

function takePending(
  index: number,
  descriptor: WatchDescriptor,
): PendingEpisodeWatch {
  const next = pending[index];
  if (next === undefined) {
    throw new Error("no episode watch fetch is waiting");
  }
  if (next.ratingKey !== descriptor.ratingKey) {
    throw new Error(
      `episode watch for ${next.ratingKey} was resolved with descriptor ${descriptor.ratingKey}`,
    );
  }
  pending.splice(index, 1);
  return next;
}

/**
 * Resolves the newest pending fetchEpisodeWatch with this descriptor.
 *
 * @throws Error when nothing is waiting, or the waiting rating key does not
 * match the descriptor.
 */
export async function resolveLatestEpisodeWatch(
  descriptor: WatchDescriptor,
): Promise<void> {
  const next = takePending(pending.length - 1, descriptor);
  await act(async () => {
    next.resolve(descriptor);
    await Promise.resolve();
  });
}

/**
 * Resolves the newest pending fetchEpisodeWatch like
 * resolveLatestEpisodeWatch, and runs `between` inside the same act, right
 * after the callbacks the page attached to that fetch have run. React has
 * not committed what those callbacks set yet, so `between` sees the page in
 * the gap between "the descriptor arrived" and "the new stream replaced the
 * old one". resolveLatestEpisodeWatch alone flushes React before a test can
 * step in.
 *
 * @throws Error when nothing is waiting, or the waiting rating key does not
 * match the descriptor. Whatever `between` throws also propagates.
 */
export async function resolveLatestEpisodeWatchThen(
  descriptor: WatchDescriptor,
  between: () => void,
): Promise<void> {
  const next = takePending(pending.length - 1, descriptor);
  await act(async () => {
    next.resolve(descriptor);
    await Promise.resolve();
    between();
  });
}

/**
 * Resolves the newest pending fetchEpisodeWatch for the descriptor's rating
 * key, even when a newer fetch for another rating key is waiting. This is how
 * a test delivers a fetch that the page has since stopped caring about.
 *
 * @throws Error when no pending fetch has this descriptor's rating key.
 */
export async function resolvePendingEpisodeWatchFor(
  descriptor: WatchDescriptor,
): Promise<void> {
  let index = -1;
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    if (pending[i]?.ratingKey === descriptor.ratingKey) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    throw new Error(`no episode watch fetch is waiting for ${descriptor.ratingKey}`);
  }
  const next = takePending(index, descriptor);
  await act(async () => {
    next.resolve(descriptor);
    await Promise.resolve();
  });
}

/**
 * Rejects the newest pending fetchEpisodeWatch for this rating key with this
 * error, even when a newer fetch for another rating key is waiting. This is
 * how a test fails a fetch that the page has since stopped caring about.
 *
 * @throws Error when no pending fetch has this rating key.
 */
export async function rejectPendingEpisodeWatchFor(
  ratingKey: string,
  error: unknown,
): Promise<void> {
  let index = -1;
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    if (pending[i]?.ratingKey === ratingKey) {
      index = i;
      break;
    }
  }
  const next = pending[index];
  if (next === undefined) {
    throw new Error(`no episode watch fetch is waiting for ${ratingKey}`);
  }
  pending.splice(index, 1);
  await act(async () => {
    next.reject(error);
    await Promise.resolve();
  });
}

/**
 * Renders WatchPage at /watch/episode/:ratingKey inside MemoryRouter.
 * Pass strict to wrap the page in React StrictMode.
 */
export function renderWatchPage(options?: {
  ratingKey?: string;
  strict?: boolean;
}): { ratingKey: string; unmount: () => void } {
  const ratingKey = options?.ratingKey ?? DEFAULT_RATING_KEY;
  const page =
    options?.strict === true ? (
      <StrictMode>
        <WatchPage />
      </StrictMode>
    ) : (
      <WatchPage />
    );
  const view = render(
    <MemoryRouter initialEntries={[`/watch/episode/${ratingKey}`]}>
      <Routes>
        <Route path="/watch/episode/:ratingKey" element={page} />
      </Routes>
    </MemoryRouter>,
  );
  return { ratingKey, unmount: view.unmount };
}
