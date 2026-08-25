import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TransmissionUpstreamError } from "./client";
import {
  normalizeSessionStats,
  normalizeTorrent,
} from "./normalize";
import {
  SESSION_STATS_ARGUMENTS,
  TORRENT_GET_ROW,
} from "./recordedSamples";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...TORRENT_GET_ROW, ...overrides };
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
