import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TransmissionUpstreamError } from "./client";
import {
  normalizeSessionStats,
  normalizeTorrent,
  normalizeTorrentDetail,
} from "./normalize";
import {
  SESSION_STATS_ARGUMENTS,
  TORRENT_GET_ROW,
} from "./recordedSamples";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...TORRENT_GET_ROW, ...overrides };
}

function detailRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    hashString: "detail-hash",
    name: "Example detail",
    totalSize: 3000,
    pieceCount: 3,
    pieceSize: 1000,
    isPrivate: false,
    comment: "",
    creator: "fixture",
    dateCreated: 0,
    addedDate: 100,
    doneDate: 0,
    activityDate: 0,
    downloadDir: "/downloads",
    downloadedEver: 2500,
    uploadedEver: 500,
    corruptEver: 10,
    haveValid: 2400,
    secondsDownloading: 60,
    secondsSeeding: 30,
    errorString: "",
    files: [
      {
        begin_piece: 0,
        bytesCompleted: 400,
        end_piece: 0,
        length: 1000,
        name: "first.mkv",
      },
      {
        begin_piece: 1,
        bytesCompleted: 1500,
        end_piece: 2,
        length: 2000,
        name: "second.mkv",
      },
    ],
    fileStats: [
      { bytesCompleted: 400, priority: -1, wanted: false },
      { bytesCompleted: 1500, priority: 1, wanted: true },
    ],
    peers: [],
    trackerStats: [
      {
        host: "unknown.example",
        tier: 0,
        isBackup: false,
        seederCount: -1,
        leecherCount: -1,
        downloadCount: -1,
        lastAnnounceSucceeded: false,
        lastAnnounceResult: "",
        nextAnnounceTime: 0,
      },
      {
        host: "empty.example",
        tier: 1,
        isBackup: true,
        seederCount: 0,
        leecherCount: 0,
        downloadCount: 0,
        lastAnnounceSucceeded: true,
        lastAnnounceResult: "Success",
        nextAnnounceTime: 200,
      },
    ],
    ...overrides,
  };
}

describe("normalizeTorrent recorded protocol shape", () => {
  it("maps TORRENT_GET_ROW field by field", () => {
    const view = normalizeTorrent(TORRENT_GET_ROW);

    assert.equal(view.hash, "c555a15c97f99ac1347e29491be7f017fb2811d1");
    assert.equal(view.name, "Example.Show.S01E01.1080p.WEB-DL");
    assert.deepEqual(view.labels, ["tv-sonarr"]);
    assert.equal(view.state, "seeding-complete");
    assert.equal(view.status, 0);
    assert.equal(view.isStalled, false);
    assert.equal(view.progress, 1.0);
    assert.equal(view.sizeBytes, 4578806439);
    assert.equal(view.downloadedBytes, 4578806439);
    assert.equal(view.uploadedBytes, 9158541625);
    assert.equal(view.ratio, 2.0002028942108154);
    assert.equal(view.rateDownload, 0);
    assert.equal(view.rateUpload, 0);
    assert.equal(view.etaSeconds, null);
    assert.deepEqual(view.peers, {
      connected: 0,
      sendingToUs: 0,
      gettingFromUs: 0,
    });
    assert.equal(view.error, null);
    assert.equal(view.queuePosition, 0);
    assert.equal(view.downloadDir, "/Volumes/MediaStore2/torrents/tv-sonarr");
    assert.equal(view.addedAtMs, 1782091064000);
    assert.equal(view.doneAtMs, 1782092105000);
    assert.equal(view.recheckProgress, 0.0);
    assert.equal(view.metadataPercentComplete, 1.0);
  });
});

describe("normalizeSessionStats recorded protocol shape", () => {
  it("maps SESSION_STATS_ARGUMENTS field by field", () => {
    const session = normalizeSessionStats(SESSION_STATS_ARGUMENTS);

    assert.equal(session.torrentCount, 10);
    assert.equal(session.activeCount, 5);
    assert.equal(session.pausedCount, 5);
    assert.equal(session.rateDownload, 11419648);
    assert.equal(session.rateUpload, 1883147);
  });
});

describe("normalizeTorrent state from status 0", () => {
  it('maps status 0 and isFinished true to "seeding-complete"', () => {
    const view = normalizeTorrent(row({ status: 0, isFinished: true }));
    assert.equal(view.state, "seeding-complete");
  });

  it('maps status 0 and isFinished false to "stopped"', () => {
    const view = normalizeTorrent(row({ status: 0, isFinished: false }));
    assert.equal(view.state, "stopped");
  });
});

describe("normalizeTorrent etaSeconds", () => {
  it("maps a negative eta to null", () => {
    assert.equal(normalizeTorrent(row({ eta: -1 })).etaSeconds, null);
    assert.equal(normalizeTorrent(row({ eta: -2 })).etaSeconds, null);
  });

  it("passes a positive eta through unchanged", () => {
    assert.equal(normalizeTorrent(row({ eta: 42 })).etaSeconds, 42);
  });
});

describe("normalizeTorrent doneAtMs", () => {
  it("maps doneDate 0 to null", () => {
    assert.equal(normalizeTorrent(row({ doneDate: 0 })).doneAtMs, null);
  });

  it("maps a real doneDate to seconds times 1000", () => {
    assert.equal(
      normalizeTorrent(row({ doneDate: 1782092105 })).doneAtMs,
      1782092105000,
    );
  });
});

describe("normalizeTorrent error", () => {
  it("maps error 0 to null", () => {
    assert.equal(normalizeTorrent(row({ error: 0, errorString: "" })).error, null);
  });

  it("maps a non-zero error to { code, message }", () => {
    assert.deepEqual(
      normalizeTorrent(row({ error: 3, errorString: "tracker failed" })).error,
      { code: 3, message: "tracker failed" },
    );
  });
});

describe("normalizeTorrent strictness", () => {
  it("throws TransmissionUpstreamError naming hashString when it is absent", () => {
    const { hashString: _h, ...withoutHash } = TORRENT_GET_ROW;
    assert.throws(
      () => normalizeTorrent(withoutHash),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError &&
        err.status === 502 &&
        err.message.includes("hashString"),
    );
  });

  it("throws TransmissionUpstreamError naming percentDone when it is a string", () => {
    assert.throws(
      () => normalizeTorrent(row({ percentDone: "1" })),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError &&
        err.status === 502 &&
        err.message.includes("percentDone") &&
        err.message.includes("c555a15c97f99ac1347e29491be7f017fb2811d1"),
    );
  });
});

describe("normalizeTorrentDetail", () => {
  it("zips files and fileStats by index without mixing their fields", () => {
    const detail = normalizeTorrentDetail(detailRow());

    assert.deepEqual(detail.files, [
      {
        name: "first.mkv",
        lengthBytes: 1000,
        completedBytes: 400,
        wanted: false,
        priority: -1,
        progress: 0.4,
      },
      {
        name: "second.mkv",
        lengthBytes: 2000,
        completedBytes: 1500,
        wanted: true,
        priority: 1,
        progress: 0.75,
      },
    ]);
  });

  it("throws with both lengths when files and fileStats differ", () => {
    assert.throws(
      () =>
        normalizeTorrentDetail(
          detailRow({
            fileStats: [{ bytesCompleted: 400, priority: -1, wanted: false }],
          }),
        ),
      (err: unknown) =>
        err instanceof TransmissionUpstreamError &&
        err.message.includes("files length 2") &&
        err.message.includes("fileStats length 1") &&
        err.message.includes("detail-hash"),
    );
  });

  it("maps negative tracker counts to null but preserves zero", () => {
    const detail = normalizeTorrentDetail(detailRow());

    assert.equal(detail.trackers[0]?.seeders, null);
    assert.equal(detail.trackers[0]?.leechers, null);
    assert.equal(detail.trackers[0]?.downloads, null);
    assert.equal(detail.trackers[1]?.seeders, 0);
    assert.equal(detail.trackers[1]?.leechers, 0);
    assert.equal(detail.trackers[1]?.downloads, 0);
  });

  it("maps dateCreated 0 to null and a real value to milliseconds", () => {
    assert.equal(normalizeTorrentDetail(detailRow()).info.createdAtMs, null);
    assert.equal(
      normalizeTorrentDetail(detailRow({ dateCreated: 1_700_000_000 })).info
        .createdAtMs,
      1_700_000_000_000,
    );
  });
});
