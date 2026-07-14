import type {
  MediaAvailabilityStatus,
  RequestRow,
} from "../db/requests";
import type { RadarrClient } from "../radarr/client";
import type { SonarrClient } from "../sonarr/client";
import type { TmdbClient } from "../tmdb/client";

export type ProcessMediaConfig = {
  radarrQualityProfileId: number;
  radarrRootFolder: string;
  radarrMinimumAvailability: string;
  sonarrQualityProfileId: number;
  sonarrRootFolder: string;
  sonarrLanguageProfileId: number | null;
};

export type ProcessMediaDeps = {
  tmdb: TmdbClient;
  radarr: RadarrClient;
  sonarr: SonarrClient;
  config: ProcessMediaConfig;
};

export type ProcessMediaResult = {
  radarrId?: number | null;
  sonarrId?: number | null;
  mediaStatus: MediaAvailabilityStatus;
};

export async function processMedia(
  request: RequestRow,
  deps: ProcessMediaDeps,
): Promise<ProcessMediaResult> {
  const { tmdb, radarr, sonarr, config } = deps;

  if (request.mediaType === "movie") {
    const detail = await tmdb.movieDetail(request.tmdbId);
    const result = await radarr.addMovie({
      tmdbId: request.tmdbId,
      title: request.title,
      year: detail.year ?? 0,
      qualityProfileId: config.radarrQualityProfileId,
      rootFolderPath: config.radarrRootFolder,
      minimumAvailability: config.radarrMinimumAvailability,
    });
    return {
      radarrId: result.id ?? null,
      mediaStatus: result.hasFile ? "available" : "processing",
    };
  }

  const detail = await tmdb.tvDetail(request.tmdbId);
  if (detail.tvdbId === null) {
    throw new Error("TV series has no tvdbId; cannot send to Sonarr");
  }

  const result = await sonarr.addSeries({
    tvdbId: detail.tvdbId,
    title: request.title,
    qualityProfileId: config.sonarrQualityProfileId,
    languageProfileId: config.sonarrLanguageProfileId ?? undefined,
    seasons: request.seasons ?? [],
    rootFolderPath: config.sonarrRootFolder,
  });

  return {
    sonarrId: result.id ?? null,
    mediaStatus: "processing",
  };
}
