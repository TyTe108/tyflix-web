// Page stops for the Episodes rail. The three widths are the ones section 9
// of docs/phase-58-episode-rail-scroll-spec.md recorded for ten tiles.
import { describe, expect, it } from "vitest";
import { pageTarget, railState, type RailMetrics } from "./railGeometry";

const AT_1440: RailMetrics = {
  scrollLeft: 0,
  scrollWidth: 3452,
  clientWidth: 1440,
  paddingStart: 60,
  paddingEnd: 60,
  tileWidth: 315.2,
  pitch: 335.2,
  tileCount: 10,
};

const AT_1024: RailMetrics = {
  scrollLeft: 0,
  scrollWidth: 2519,
  clientWidth: 1024,
  paddingStart: 43.008,
  paddingEnd: 43.008,
  tileWidth: 225.28,
  pitch: 245.28,
  tileCount: 10,
};

const AT_1920: RailMetrics = {
  scrollLeft: 0,
  scrollWidth: 3452,
  clientWidth: 1920,
  paddingStart: 60,
  paddingEnd: 60,
  tileWidth: 315.2,
  pitch: 335.2,
  tileCount: 10,
};

const FITS = {
  overflows: false,
  atStart: true,
  atEnd: true,
  page: 0,
  pageStarts: [0],
};

const FIELDS = [
  "scrollLeft",
  "scrollWidth",
  "clientWidth",
  "paddingStart",
  "paddingEnd",
  "tileWidth",
  "pitch",
  "tileCount",
] as const satisfies readonly (keyof RailMetrics)[];

function at(base: RailMetrics, scrollLeft: number): RailMetrics {
  return { ...base, scrollLeft };
}

function expectClose(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value);
  });
}

describe("railState", () => {
  it("pages a 1440 px row through 0, 1340.8 and the end", () => {
    const start = railState(at(AT_1440, 0));
    expect(start.overflows).toBe(true);
    expect(start.atStart).toBe(true);
    expect(start.atEnd).toBe(false);
    expect(start.page).toBe(0);
    expectClose(start.pageStarts, [0, 1340.8, 2012]);
    expect(pageTarget(at(AT_1440, 0), 1)).toBeCloseTo(1340.8);

    const middle = railState(at(AT_1440, 1340.8));
    expect(middle.atStart).toBe(false);
    expect(middle.atEnd).toBe(false);
    expect(middle.page).toBe(1);
    expect(pageTarget(at(AT_1440, 1340.8), -1)).toBeCloseTo(0);
    expect(pageTarget(at(AT_1440, 1340.8), 1)).toBeCloseTo(2012);

    const end = railState(at(AT_1440, 2012));
    expect(end.atEnd).toBe(true);
    expect(end.page).toBe(2);
    expect(pageTarget(at(AT_1440, 2012), 1)).toBeCloseTo(2012);

    const nearEnd = railState(at(AT_1440, 2011.2));
    expect(nearEnd.atEnd).toBe(true);
    expect(pageTarget(at(AT_1440, 2011.2), 1)).toBeCloseTo(2012);

    const between = railState(at(AT_1440, 1000));
    expect(between.page).toBe(0);
    expect(pageTarget(at(AT_1440, 1000), 1)).toBeCloseTo(1340.8);
    expect(pageTarget(at(AT_1440, 1000), -1)).toBeCloseTo(0);
  });

  it("drops the 1024 px stop that sits within half a tile of the end", () => {
    const state = railState(AT_1024);
    expect(state.overflows).toBe(true);
    expectClose(state.pageStarts, [0, 735.84, 1495]);
    expect(state.pageStarts.some((start) => Math.abs(start - 1471.68) < 1)).toBe(
      false,
    );
  });

  it("pages a 1920 px row from 0 straight to the end", () => {
    const state = railState(AT_1920);
    expect(state.overflows).toBe(true);
    expectClose(state.pageStarts, [0, 1532]);
  });

  it("reports no overflow when the row fits, or is only 1 px wider", () => {
    expect(
      railState({ ...AT_1440, scrollWidth: 1440, clientWidth: 1440 }),
    ).toEqual(FITS);
    expect(
      railState({ ...AT_1440, scrollWidth: 1441, clientWidth: 1440 }),
    ).toEqual(FITS);
  });

  it("counts four tiles as a page at 1440, where they need 1320.8 px of a 1320 px column", () => {
    const state = railState(AT_1440);
    expect(state.pageStarts[1]).toBeCloseTo(4 * 335.2);
  });

  describe("RangeError", () => {
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, -1] as const;

    for (const field of FIELDS) {
      for (const value of bad) {
        it(`rejects ${field} ${value}`, () => {
          const metrics: RailMetrics = { ...AT_1440, [field]: value };
          expect(() => railState(metrics)).toThrow(RangeError);
          try {
            railState(metrics);
          } catch (err) {
            expect(err).toBeInstanceOf(RangeError);
            expect((err as RangeError).message).toContain(`${field} ${value}`);
          }
        });
      }
    }

    it("rejects a tileCount that is not an integer", () => {
      const metrics: RailMetrics = { ...AT_1440, tileCount: 2.5 };
      expect(() => railState(metrics)).toThrow(RangeError);
      try {
        railState(metrics);
      } catch (err) {
        expect((err as RangeError).message).toContain("tileCount 2.5");
      }
    });

    it("rejects a tile width of 0 when the row overflows", () => {
      const metrics: RailMetrics = { ...AT_1440, tileWidth: 0 };
      expect(() => railState(metrics)).toThrow(RangeError);
      try {
        railState(metrics);
      } catch (err) {
        expect((err as RangeError).message).toContain("tileWidth 0");
      }
    });

    it("rejects a pitch of 0 when the row overflows", () => {
      const metrics: RailMetrics = { ...AT_1440, pitch: 0 };
      expect(() => railState(metrics)).toThrow(RangeError);
      try {
        railState(metrics);
      } catch (err) {
        expect((err as RangeError).message).toContain("pitch 0");
      }
    });
  });
});
