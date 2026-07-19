import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import { requireAuth } from "../middleware/auth";
import type { CreateSeerrIssueInput } from "../seerr/client";
import type { IssueStatus, IssueView } from "../seerr/issues";
import { issueSession, SESSION_COOKIE_NAME } from "../session";
import { createMediaEnrichment } from "../tmdb/enrichment";
import {
  createIssuesRouter,
  type IssuesRouterDeps,
} from "./issues";

const SECRET = "sixteen-chars!!!";
const ADMIN_PERMISSION = 2;

type FakeRes = {
  cookies: Array<{ name: string; value: string }>;
  cookie(name: string, value: string): void;
};

function sessionCookie(permissions = 0, seerrUserId = 7): string {
  const cookies: Array<{ name: string; value: string }> = [];
  const res: FakeRes = {
    cookies,
    cookie(name, value) {
      cookies.push({ name, value });
    },
  };
  issueSession(
    res as unknown as import("express").Response,
    {
      seerrUserId,
      plexId: 10,
      plexUsername: "tyler",
      displayName: "Tyler",
      avatar: null,
      permissions,
    },
    { secret: SECRET, secure: false },
  );
  return `${SESSION_COOKIE_NAME}=${cookies[0].value}`;
}

function issueView(overrides: Partial<IssueView> = {}): IssueView {
  return {
    id: 51,
    issueType: "video",
    status: "open",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T01:00:00.000Z",
    problemSeason: null,
    problemEpisode: null,
    media: {
      id: 10,
      tmdbId: 603,
      mediaType: "movie",
      title: null,
      posterUrl: null,
    },
    createdBy: {
      id: 7,
      displayName: "Tyler",
      plexUsername: "tyler",
    },
    comments: [],
    ...overrides,
  };
}

function createStubSeerr(
  overrides: Partial<IssuesRouterDeps["seerr"]> = {},
): IssuesRouterDeps["seerr"] & {
  createCalls: CreateSeerrIssueInput[];
  commentCalls: Array<{ issueId: number; message: string }>;
  statusCalls: Array<{ issueId: number; status: IssueStatus }>;
} {
  const createCalls: CreateSeerrIssueInput[] = [];
  const commentCalls: Array<{ issueId: number; message: string }> = [];
  const statusCalls: Array<{ issueId: number; status: IssueStatus }> = [];
  return {
    createCalls,
    commentCalls,
    statusCalls,
    async listIssues() {
      return [];
    },
    async getIssue(id) {
      return issueView({ id });
    },
    async createIssue(input) {
      createCalls.push(input);
      return issueView();
    },
    async addIssueComment(issueId, message) {
      commentCalls.push({ issueId, message });
      return issueView({
        id: issueId,
        comments: [
          {
            id: 91,
            message,
            createdAt: "2026-07-15T02:00:00.000Z",
            user: { id: 7, displayName: "Tyler" },
          },
        ],
      });
    },
    async setIssueStatus(issueId, status) {
      statusCalls.push({ issueId, status });
      return issueView({ id: issueId, status });
    },
    ...overrides,
  };
}

function createApp(
  seerr: IssuesRouterDeps["seerr"],
  mediaId: number | null = 10,
  mediaEnrichment: IssuesRouterDeps["mediaEnrichment"] = {
    async enrich() {
      return new Map();
    },
  },
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/issues",
    requireAuth(SECRET),
    createIssuesRouter({
      seerr,
      mediaStatus: {
        async getStatusMap() {
          return new Map();
        },
        async getMediaId(mediaType, tmdbId) {
          return mediaType === "movie" && tmdbId === 603 ? mediaId : null;
        },
        async getRatingKey() {
          return null;
        },
      },
      mediaEnrichment,
    }),
  );
  return app;
}

describe("issue routes", () => {
  it("creates an attributed issue using the resolved Seerr media id", async () => {
    const seerr = createStubSeerr();
    const response = await fetchLocal(createApp(seerr), "POST", "/api/issues", {
      cookie: sessionCookie(0, 44),
      body: {
        tmdbId: 603,
        mediaType: "movie",
        issueType: "audio",
        message: " Audio is out of sync ",
        problemSeason: 0,
        problemEpisode: 2,
      },
    });

    assert.equal(response.status, 201);
    assert.deepEqual(seerr.createCalls, [
      {
        issueType: "audio",
        message: "Audio is out of sync",
        mediaId: 10,
        userId: 44,
        problemSeason: 0,
        problemEpisode: 2,
      },
    ]);
  });

  it("returns 404 and does not create an issue for untracked media", async () => {
    const seerr = createStubSeerr();
    const response = await fetchLocal(
      createApp(seerr, null),
      "POST",
      "/api/issues",
      {
        cookie: sessionCookie(),
        body: {
          tmdbId: 603,
          mediaType: "movie",
          issueType: "video",
          message: "Playback fails",
        },
      },
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "media not tracked" });
    assert.equal(seerr.createCalls.length, 0);
  });

  it("enforces owner-or-admin access for detail, comments, and status", async () => {
    const seerr = createStubSeerr();
    const app = createApp(seerr);
    const nonOwner = { cookie: sessionCookie(0, 8) };

    const forbiddenDetail = await fetchLocal(
      app,
      "GET",
      "/api/issues/51",
      nonOwner,
    );
    const forbiddenComment = await fetchLocal(
      app,
      "POST",
      "/api/issues/51/comment",
      { ...nonOwner, body: { message: "Unauthorized" } },
    );
    const forbiddenStatus = await fetchLocal(
      app,
      "POST",
      "/api/issues/51/status",
      { ...nonOwner, body: { status: "resolved" } },
    );

    assert.equal(forbiddenDetail.status, 403);
    assert.equal(forbiddenComment.status, 403);
    assert.equal(forbiddenStatus.status, 403);
    assert.equal(seerr.commentCalls.length, 0);
    assert.equal(seerr.statusCalls.length, 0);

    const ownerDetail = await fetchLocal(app, "GET", "/api/issues/51", {
      cookie: sessionCookie(0, 7),
    });
    const ownerComment = await fetchLocal(
      app,
      "POST",
      "/api/issues/51/comment",
      {
        cookie: sessionCookie(0, 7),
        body: { message: "More detail" },
      },
    );
    const adminStatus = await fetchLocal(
      app,
      "POST",
      "/api/issues/51/status",
      {
        cookie: sessionCookie(ADMIN_PERMISSION, 8),
        body: { status: "resolved" },
      },
    );

    assert.equal(ownerDetail.status, 200);
    assert.equal(ownerComment.status, 200);
    assert.equal(adminStatus.status, 200);
    assert.deepEqual(seerr.commentCalls, [
      { issueId: 51, message: "More detail" },
    ]);
    assert.deepEqual(seerr.statusCalls, [
      { issueId: 51, status: "resolved" },
    ]);
  });

  it("scopes personal lists and restricts the all-users list to admins", async () => {
    let calls = 0;
    const issues = [
      issueView({
        id: 51,
        createdBy: {
          id: 44,
          displayName: "Current user",
          plexUsername: "current",
        },
      }),
      issueView({
        id: 52,
        createdBy: {
          id: 7,
          displayName: "Another user",
          plexUsername: "another",
        },
      }),
    ];
    const seerr = createStubSeerr({
      async listIssues() {
        calls += 1;
        return issues;
      },
    });
    const app = createApp(seerr);

    const mine = await fetchLocal(app, "GET", "/api/issues", {
      cookie: sessionCookie(0, 44),
    });
    const forbidden = await fetchLocal(app, "GET", "/api/issues/all", {
      cookie: sessionCookie(0, 44),
    });
    const all = await fetchLocal(app, "GET", "/api/issues/all", {
      cookie: sessionCookie(ADMIN_PERMISSION, 44),
    });

    assert.equal(mine.status, 200);
    assert.equal(forbidden.status, 403);
    assert.equal(all.status, 200);
    assert.deepEqual(
      ((await mine.json()) as { results: IssueView[] }).results.map(
        (issue) => issue.id,
      ),
      [51],
    );
    assert.deepEqual(
      ((await all.json()) as { results: IssueView[] }).results.map(
        (issue) => issue.id,
      ),
      [51, 52],
    );
    assert.equal(calls, 2);
  });

  it("enriches media on personal, all-users, and detail responses", async () => {
    const issue = issueView();
    const seerr = createStubSeerr({
      async listIssues() {
        return [issue];
      },
      async getIssue() {
        return issue;
      },
    });
    const mediaEnrichment: IssuesRouterDeps["mediaEnrichment"] = {
      async enrich(items) {
        assert.ok(items.some((item) => item.tmdbId === 603));
        return new Map([
          [
            "movie:603",
            {
              title: "The Matrix",
              posterUrl: "https://image.tmdb.org/t/p/w500/matrix.jpg",
            },
          ],
        ]);
      },
    };
    const app = createApp(seerr, 10, mediaEnrichment);

    const mine = await fetchLocal(app, "GET", "/api/issues", {
      cookie: sessionCookie(),
    });
    const all = await fetchLocal(app, "GET", "/api/issues/all", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    const detail = await fetchLocal(app, "GET", "/api/issues/51", {
      cookie: sessionCookie(),
    });

    assert.equal(mine.status, 200);
    assert.equal(all.status, 200);
    assert.equal(detail.status, 200);
    const expectedMedia = {
      id: 10,
      tmdbId: 603,
      mediaType: "movie",
      title: "The Matrix",
      posterUrl: "https://image.tmdb.org/t/p/w500/matrix.jpg",
    };
    assert.deepEqual(
      ((await mine.json()) as { results: IssueView[] }).results[0].media,
      expectedMedia,
    );
    assert.deepEqual(
      ((await all.json()) as { results: IssueView[] }).results[0].media,
      expectedMedia,
    );
    assert.deepEqual(
      ((await detail.json()) as IssueView).media,
      expectedMedia,
    );
  });

  it("returns issue media with null enrichment when TMDB fails", async () => {
    const mediaEnrichment = createMediaEnrichment({
      async movieDetail() {
        throw new Error("TMDB unavailable");
      },
      async tvDetail() {
        throw new Error("TMDB unavailable");
      },
    });
    const response = await fetchLocal(
      createApp(createStubSeerr(), 10, mediaEnrichment),
      "GET",
      "/api/issues/51",
      { cookie: sessionCookie() },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as IssueView).media, {
      id: 10,
      tmdbId: 603,
      mediaType: "movie",
      title: null,
      posterUrl: null,
    });
  });
});

async function fetchLocal(
  app: express.Express,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    const headers: Record<string, string> = {};
    if (options.cookie) {
      headers.Cookie = options.cookie;
    }
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
