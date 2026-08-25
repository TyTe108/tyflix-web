import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import { isAdmin, type SessionPayload } from "../session";
import { TransmissionUpstreamError } from "../transmission/client";
import {
  SESSION_STATS_ARGUMENTS,
  TORRENT_GET_ROW,
} from "../transmission/recordedSamples";
import {
  createAdminTransmissionRouter,
  type AdminTransmissionRouterDeps,
} from "./adminTransmission";

const adminSession: SessionPayload = {
  seerrUserId: 1,
  plexId: 10,
  plexUsername: "tyler",
  displayName: "Tyler",
  avatar: null,
  permissions: 2,
  iat: 1,
  exp: 2,
};

const nonAdminSession: SessionPayload = {
  ...adminSession,
  seerrUserId: 7,
  permissions: 0,
};

const FORBIDDEN_TORRENT_GET_FIELDS = [
  "trackerStats",
  "files",
  "peers",
  "pieces",
  "id",
];

function createTrackingDeps(options: {
  fieldsSeen: string[][];
  idsSeen?: Array<string[] | undefined>;
  listResult?: unknown;
  detailResult?: unknown;
  listError?: Error;
  statsResult?: unknown;
  statsError?: Error;
}): AdminTransmissionRouterDeps {
  return {
    transmission: {
      async listTorrents(fields: string[], ids?: string[]) {
        options.fieldsSeen.push(fields);
        options.idsSeen?.push(ids);
        if (options.listError) {
          throw options.listError;
        }
        if (ids !== undefined && options.detailResult !== undefined) {
          return options.detailResult as object;
        }
        return (
          options.listResult ?? {
            torrents: [TORRENT_GET_ROW],
          }
        );
      },
      async getSessionStats() {
        if (options.statsError) {
          throw options.statsError;
        }
        return options.statsResult ?? SESSION_STATS_ARGUMENTS;
      },
    },
  };
}

const DETAIL_ROW = {
  hashString: "abc123",
  name: "Example detail",
  totalSize: 1000,
  pieceCount: 1,
  pieceSize: 1000,
  isPrivate: false,
  comment: "",
  creator: "",
  dateCreated: 0,
  addedDate: 100,
  doneDate: 0,
  activityDate: 0,
  downloadDir: "/downloads",
  downloadedEver: 1000,
  uploadedEver: 0,
  corruptEver: 0,
  haveValid: 1000,
  secondsDownloading: 10,
  secondsSeeding: 0,
  errorString: "",
  files: [],
  fileStats: [],
  peers: [],
  trackerStats: [],
};

describe("GET /api/admin/transmission/torrents", () => {
  it("returns 401 with no session", async () => {
    const fieldsSeen: string[][] = [];
    const response = await fetchLocal(
      createApp(createTrackingDeps({ fieldsSeen }), null),
      "/api/admin/transmission/torrents",
    );
    assert.equal(response.status, 401);
    assert.deepEqual(fieldsSeen, []);
  });

  it("returns 403 with a non-admin session", async () => {
    const fieldsSeen: string[][] = [];
    const response = await fetchLocal(
      createApp(createTrackingDeps({ fieldsSeen }), nonAdminSession),
      "/api/admin/transmission/torrents",
    );
    assert.equal(response.status, 403);
    assert.deepEqual(fieldsSeen, []);
  });

  it("returns 200 with normalised torrents and session for an admin", async () => {
    const fieldsSeen: string[][] = [];
    const response = await fetchLocal(
      createApp(createTrackingDeps({ fieldsSeen })),
      "/api/admin/transmission/torrents",
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      torrents: Array<{ hash: string; state: string }>;
      session: { torrentCount: number };
    };
    assert.equal(body.torrents.length, 1);
    assert.equal(
      body.torrents[0]?.hash,
      "c555a15c97f99ac1347e29491be7f017fb2811d1",
    );
    assert.equal(body.torrents[0]?.state, "seeding-complete");
    assert.equal(body.session.torrentCount, 10);
  });

  it("asks torrent-get for none of trackerStats, files, peers, pieces, or id", async () => {
    const fieldsSeen: string[][] = [];
    const response = await fetchLocal(
      createApp(createTrackingDeps({ fieldsSeen })),
      "/api/admin/transmission/torrents",
    );
    assert.equal(response.status, 200);
    assert.equal(fieldsSeen.length, 1);
    const fields = fieldsSeen[0] ?? [];
    for (const forbidden of FORBIDDEN_TORRENT_GET_FIELDS) {
      assert.equal(
        fields.includes(forbidden),
        false,
        `torrent-get must not request ${forbidden}`,
      );
    }
  });

  it("returns 502 when Transmission throws, not the upstream status", async () => {
    const fieldsSeen: string[][] = [];
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = await fetchLocal(
        createApp(
          createTrackingDeps({
            fieldsSeen,
            listError: new TransmissionUpstreamError("conflict", 409),
          }),
        ),
        "/api/admin/transmission/torrents",
      );
      assert.equal(response.status, 502);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, "conflict");
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe("GET /api/admin/transmission/torrents/:hash", () => {
  it("returns 401 with no session", async () => {
    const fieldsSeen: string[][] = [];
    const response = await fetchLocal(
      createApp(createTrackingDeps({ fieldsSeen }), null),
      "/api/admin/transmission/torrents/abc123",
    );
    assert.equal(response.status, 401);
    assert.deepEqual(fieldsSeen, []);
  });

  it("returns 403 with a non-admin session", async () => {
    const fieldsSeen: string[][] = [];
    const response = await fetchLocal(
      createApp(createTrackingDeps({ fieldsSeen }), nonAdminSession),
      "/api/admin/transmission/torrents/abc123",
    );
    assert.equal(response.status, 403);
    assert.deepEqual(fieldsSeen, []);
  });

  it("returns 200 with normalised detail for an admin", async () => {
    const fieldsSeen: string[][] = [];
    const response = await fetchLocal(
      createApp(
        createTrackingDeps({
          fieldsSeen,
          detailResult: { torrents: [DETAIL_ROW] },
        }),
      ),
      "/api/admin/transmission/torrents/abc123",
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { hash: string; name: string };
    assert.deepEqual(body, {
      ...body,
      hash: "abc123",
      name: "Example detail",
    });
  });

  it("scopes torrent-get with ids and does not request magnetLink", async () => {
    const fieldsSeen: string[][] = [];
    const idsSeen: Array<string[] | undefined> = [];
    const response = await fetchLocal(
      createApp(
        createTrackingDeps({
          fieldsSeen,
          idsSeen,
          detailResult: { torrents: [DETAIL_ROW] },
        }),
      ),
      "/api/admin/transmission/torrents/abc123",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(idsSeen, [["abc123"]]);
    assert.equal(fieldsSeen.length, 1);
    assert.equal(fieldsSeen[0]?.includes("magnetLink"), false);
  });

  it("returns 404 when Transmission returns no matching torrent", async () => {
    const response = await fetchLocal(
      createApp(
        createTrackingDeps({
          fieldsSeen: [],
          detailResult: { torrents: [] },
        }),
      ),
      "/api/admin/transmission/torrents/missing",
    );
    assert.equal(response.status, 404);
  });
});

function createApp(
  deps: AdminTransmissionRouterDeps,
  session: SessionPayload | null = adminSession,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/transmission", (_req, res, next) => {
    if (session === null) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    if (!isAdmin(session.permissions)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.locals.session = session;
    next();
  });
  app.use("/api/admin/transmission", createAdminTransmissionRouter(deps));
  return app;
}

async function fetchLocal(
  app: express.Express,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
