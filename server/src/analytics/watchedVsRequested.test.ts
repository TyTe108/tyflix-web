import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeWatchedVsRequested,
  type AnalyticsItem,
  type AnalyticsRequest,
} from "./watchedVsRequested";

function movieRequest(
  overrides: Partial<AnalyticsRequest> & {
    ratingKey?: string | number | null;
    status?: number;
  } = {},
): AnalyticsRequest {
  const { ratingKey = "100", status = 5, ...rest } = overrides;
  return {
    type: "movie",
    createdAt: "2024-06-15T12:00:00.000Z",
    seasons: [],
    media: {
      status,
      ratingKey,
      mediaType: "movie",
    },
    ...rest,
  };
}

function tvRequest(
  overrides: Partial<AnalyticsRequest> & {
    ratingKey?: string | number | null;
    status?: number;
    seasons?: Array<{ seasonNumber: number | null }>;
  } = {},
): AnalyticsRequest {
  const {
    ratingKey = "200",
    status = 5,
    seasons = [{ seasonNumber: 1 }],
    ...rest
  } = overrides;
  return {
    type: "tv",
    createdAt: "2024-03-01T08:00:00.000Z",
    seasons,
    media: {
      status,
      ratingKey,
      mediaType: "tv",
    },
    ...rest,
  };
}

describe("computeWatchedVsRequested", () => {
  it("counts a watched movie as fully watched and an unwatched movie as unwatched", async () => {
    const items = new Map<string, AnalyticsItem>([
      ["10", { title: "Watched Film", sizeBytes: 1_000_000_000, episodes: null }],
      ["11", { title: "Unwatched Film", sizeBytes: 500_000_000, episodes: null }],
    ]);

    const result = await computeWatchedVsRequested(
      [
        movieRequest({ ratingKey: "10", createdAt: "2024-01-01T00:00:00Z" }),
        movieRequest({ ratingKey: "11", createdAt: "2024-02-01T00:00:00Z" }),
      ],
      { movies: new Set(["10"]), episodes: new Set() },
      (rk) => {
        const item = items.get(rk);
        assert.ok(item);
        return item;
      },
    );

    assert.equal(result.totals.requests, 2);
    assert.equal(result.totals.available, 2);
    assert.equal(result.totals.pending, 0);
    assert.equal(result.totals.gbRequestedBytes, 1_500_000_000);
    assert.equal(result.totals.gbWatchedBytes, 1_000_000_000);
    assert.equal(result.totals.gbUnwatchedBytes, 500_000_000);
    assert.equal(result.totals.rate, 67);
    assert.deepEqual(result.unwatchedTitles, [
      {
        title: "Unwatched Film",
        type: "movie",
        unwatchedBytes: 500_000_000,
        epsWatched: 0,
        epsTotal: 1,
        requestedAt: "2024-02-01",
      },
    ]);
  });

  it("scopes a show to requested seasons and counts partial watch progress", async () => {
    const show: AnalyticsItem = {
      title: "Partial Show",
      sizeBytes: 600,
      episodes: [
        { rk: "e1", sizeBytes: 100, season: 1 },
        { rk: "e2", sizeBytes: 200, season: 1 },
        { rk: "e3", sizeBytes: 300, season: 2 },
      ],
    };

    const result = await computeWatchedVsRequested(
      [
        tvRequest({
          ratingKey: "200",
          seasons: [{ seasonNumber: 1 }],
          createdAt: "2024-05-10T00:00:00Z",
        }),
      ],
      { movies: new Set(), episodes: new Set(["e1"]) },
      (_rk, isShow) => {
        assert.equal(isShow, true);
        return show;
      },
    );

    assert.equal(result.totals.gbRequestedBytes, 300);
    assert.equal(result.totals.gbWatchedBytes, 100);
    assert.equal(result.totals.gbUnwatchedBytes, 200);
    assert.equal(result.totals.rate, 33);
    assert.ok(result.totals.rate !== null);
    assert.ok(result.totals.rate > 0 && result.totals.rate < 100);
    assert.deepEqual(result.unwatchedTitles, [
      {
        title: "Partial Show",
        type: "tv",
        unwatchedBytes: 200,
        epsWatched: 1,
        epsTotal: 2,
        requestedAt: "2024-05-10",
      },
    ]);
  });

  it("counts all episodes when a TV request specifies no seasons", async () => {
    const show: AnalyticsItem = {
      title: "Whole Show",
      sizeBytes: 600,
      episodes: [
        { rk: "e1", sizeBytes: 100, season: 1 },
        { rk: "e2", sizeBytes: 200, season: 1 },
        { rk: "e3", sizeBytes: 300, season: 2 },
      ],
    };

    const result = await computeWatchedVsRequested(
      [
        tvRequest({
          ratingKey: "300",
          seasons: [],
          createdAt: "2024-07-01T00:00:00Z",
        }),
      ],
      { movies: new Set(), episodes: new Set(["e1", "e3"]) },
      () => show,
    );

    assert.equal(result.totals.gbRequestedBytes, 600);
    assert.equal(result.totals.gbWatchedBytes, 400);
    assert.equal(result.totals.gbUnwatchedBytes, 200);
    assert.equal(result.totals.rate, 67);
    assert.deepEqual(result.unwatchedTitles, [
      {
        title: "Whole Show",
        type: "tv",
        unwatchedBytes: 200,
        epsWatched: 2,
        epsTotal: 3,
        requestedAt: "2024-07-01",
      },
    ]);
  });

  it("counts status 3 requests as pending with 0 bytes requested", async () => {
    const result = await computeWatchedVsRequested(
      [
        movieRequest({ ratingKey: "10", status: 3 }),
        movieRequest({ ratingKey: "11", status: 5 }),
      ],
      { movies: new Set(), episodes: new Set() },
      (rk) => {
        assert.equal(rk, "11");
        return {
          title: "On Disk",
          sizeBytes: 42,
          episodes: null,
        };
      },
    );

    assert.equal(result.totals.requests, 2);
    assert.equal(result.totals.available, 1);
    assert.equal(result.totals.pending, 1);
    assert.equal(result.totals.gbRequestedBytes, 42);
    assert.equal(result.totals.gbWatchedBytes, 0);
    assert.equal(result.totals.gbUnwatchedBytes, 42);
  });

  it("returns null rate when nothing is on disk and sorts unwatchedTitles by bytes desc", async () => {
    const pendingOnly = await computeWatchedVsRequested(
      [movieRequest({ status: 3 }), tvRequest({ status: 2 })],
      { movies: new Set(), episodes: new Set() },
      () => {
        throw new Error("getItem should not be called for pending requests");
      },
    );

    assert.equal(pendingOnly.totals.available, 0);
    assert.equal(pendingOnly.totals.pending, 2);
    assert.equal(pendingOnly.totals.gbRequestedBytes, 0);
    assert.equal(pendingOnly.totals.rate, null);
    assert.deepEqual(pendingOnly.unwatchedTitles, []);

    const items = new Map<string, AnalyticsItem>([
      ["1", { title: "Small", sizeBytes: 10, episodes: null }],
      ["2", { title: "Large", sizeBytes: 100, episodes: null }],
      ["3", { title: "Medium", sizeBytes: 50, episodes: null }],
    ]);

    const sorted = await computeWatchedVsRequested(
      [
        movieRequest({ ratingKey: "1", createdAt: "2024-01-01T00:00:00Z" }),
        movieRequest({ ratingKey: "2", createdAt: "2024-01-02T00:00:00Z" }),
        movieRequest({ ratingKey: "3", createdAt: "2024-01-03T00:00:00Z" }),
      ],
      { movies: new Set(), episodes: new Set() },
      (rk) => {
        const item = items.get(rk);
        assert.ok(item);
        return item;
      },
    );

    assert.deepEqual(
      sorted.unwatchedTitles.map((t) => t.title),
      ["Large", "Medium", "Small"],
    );
    assert.deepEqual(
      sorted.unwatchedTitles.map((t) => t.unwatchedBytes),
      [100, 50, 10],
    );
  });
});
