import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatBytesPerSecond,
  formatDuration,
  transmissionStateLabel,
  type TransmissionTorrentState,
} from "./transmission";

describe("transmissionStateLabel", () => {
  it.each<[TransmissionTorrentState, string]>([
    ["stopped", "Paused"],
    ["seeding-complete", "Seeding complete"],
    ["check-wait", "Queued to verify"],
    ["checking", "Verifying"],
    ["download-wait", "Queued to download"],
    ["downloading", "Downloading"],
    ["seed-wait", "Queued to seed"],
    ["seeding", "Seeding"],
  ])("maps %s to %s", (state, label) => {
    expect(transmissionStateLabel(state)).toBe(label);
  });
});

describe("Transmission display formatters", () => {
  it("formats bytes with SI (1000-based) magnitudes, matching Transmission", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1.0 kB");
    expect(formatBytes(4_578_806_439)).toBe("4.6 GB");
    expect(formatBytes(9_158_541_625)).toBe("9.2 GB");
  });

  it("formats byte rates on the same SI scale", () => {
    expect(formatBytesPerSecond(1000 ** 2)).toBe("1.0 MB/s");
  });

  it("formats a duration and preserves the unknown sentinel", () => {
    expect(formatDuration(3661)).toBe("1h 1m");
    expect(formatDuration(null)).toBe("remaining time unknown");
  });
});
