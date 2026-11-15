// Page stops for the Episodes rail. The three widths are the ones section 9
// of docs/phase-58-episode-rail-scroll-spec.md recorded for ten tiles.
import { describe, expect, it } from "vitest";
import {
  countLabel,
  dragScroll,
  nearestStop,
  pageTarget,
  railState,
  thumbFractions,
  trackPressScroll,
  visibleRange,
  type RailMetrics,
} from "./railGeometry";

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

  it("drops the 1024 px stop that sits within half the pitch of the end", () => {
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

const EN = "\u2013";

function expectNames(run: () => void, name: string): void {
  expect(run).toThrow(RangeError);
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(RangeError);
    expect((err as RangeError).message).toContain(name);
  }
}

describe("the scroll bar", () => {
  it("names the whole tiles in view at the section 9 stops", () => {
    expect(visibleRange(at(AT_1440, 0))).toEqual({ first: 1, last: 4 });
    expect(visibleRange(at(AT_1440, 1340.8))).toEqual({ first: 5, last: 8 });
    expect(visibleRange(at(AT_1440, 2012))).toEqual({ first: 7, last: 10 });
    expect(visibleRange(at(AT_1920, 0))).toEqual({ first: 1, last: 5 });
    expect(visibleRange(at(AT_1920, 1532))).toEqual({ first: 6, last: 10 });
    expect(visibleRange(at(AT_1024, 0))).toEqual({ first: 1, last: 3 });
    expect(visibleRange(at(AT_1024, 735.84))).toEqual({ first: 4, last: 6 });
    expect(visibleRange(at(AT_1024, 1495))).toEqual({ first: 8, last: 10 });
    expect(visibleRange(at(AT_1440, 1000))).toEqual({ first: 4, last: 6 });
    expect(visibleRange({ ...AT_1440, clientWidth: 500, scrollLeft: 335.2 })).toEqual({
      first: 2,
      last: 2,
    });
    expect(visibleRange({ ...AT_1440, scrollWidth: 1440 })).toEqual({
      first: 1,
      last: 10,
    });
  });

  it("formats the count with an en dash, or one number when a single tile is in view", () => {
    expect(countLabel(2, 5, 10)).toBe(`2${EN}5 of 10`);
    expect(countLabel(5, 5, 10)).toBe("5 of 10");
  });

  it("sizes the thumb from the row and places it from the scroll offset", () => {
    for (const scrollLeft of [0, 1340.8, 2012]) {
      expect(thumbFractions(at(AT_1440, scrollLeft)).visible).toBeCloseTo(1440 / 3452);
    }
    expect(thumbFractions(at(AT_1440, 0)).progress).toBeCloseTo(0);
    expect(thumbFractions(at(AT_1440, 1340.8)).progress).toBeCloseTo(0.6664, 4);
    expect(thumbFractions(at(AT_1440, 2012)).progress).toBeCloseTo(1);
  });

  it("turns a drag and a track press into a scroll offset", () => {
    expect(dragScroll(AT_1440, 0, 100, 1200, 500)).toBeCloseTo(287.4286);
    expect(dragScroll(AT_1440, 0, -50, 1200, 500)).toBeCloseTo(0);
    expect(dragScroll(AT_1440, 0, 1000, 1200, 500)).toBeCloseTo(2012);
    expect(trackPressScroll(AT_1440, 1150, 1200, 500)).toBeCloseTo(2012);
    expect(trackPressScroll(AT_1440, 600, 1200, 500)).toBeCloseTo(1006);
    expect(trackPressScroll(AT_1440, 0, 1200, 500)).toBeCloseTo(0);
  });

  it("settles on the nearest tile start, including one a page start drops", () => {
    expect(nearestStop(AT_1440, 287.43)).toBeCloseTo(335.2);
    expect(nearestStop(AT_1440, 1006)).toBeCloseTo(1005.6);
    expect(nearestStop(AT_1440, 2012)).toBeCloseTo(2012);
    expect(nearestStop(AT_1024, 1100)).toBeCloseTo(981.12);
    expect(nearestStop(AT_1024, 1490)).toBeCloseTo(1495);
  });

  describe("RangeError", () => {
    it("rejects a count that starts at 0, runs backwards, passes the total, or is not an integer", () => {
      expectNames(() => countLabel(0, 5, 10), "first");
      expectNames(() => countLabel(5, 4, 10), "last");
      expectNames(() => countLabel(1, 11, 10), "last");
      expectNames(() => countLabel(2.5, 5, 10), "first");
    });

    it("rejects a drag or a press whose track, thumb or pointer is unusable", () => {
      expectNames(() => dragScroll(AT_1440, 0, 0, 0, 500), "trackWidth");
      expectNames(() => trackPressScroll(AT_1440, 0, 0, 500), "trackWidth");
      expectNames(() => dragScroll(AT_1440, 0, 0, 1200, 1200), "thumbWidth");
      expectNames(() => dragScroll(AT_1440, 0, 0, 1200, 1300), "thumbWidth");
      expectNames(() => trackPressScroll(AT_1440, 0, 1200, 1200), "thumbWidth");
      expectNames(() => trackPressScroll(AT_1440, 0, 1200, 1300), "thumbWidth");
      expectNames(() => dragScroll(AT_1440, 0, Number.NaN, 1200, 500), "deltaX");
      expectNames(() => trackPressScroll(AT_1440, Number.POSITIVE_INFINITY, 1200, 500), "pressX");
      expectNames(() => dragScroll(AT_1440, -1, 0, 1200, 500), "startScrollLeft");
      expectNames(() => nearestStop(AT_1440, Number.NaN), "scrollLeft");
      expectNames(() => visibleRange({ ...AT_1440, tileCount: 0 }), "tileCount");
    });

    it("rejects a metric that is not a finite number", () => {
      const metrics: RailMetrics = { ...AT_1440, clientWidth: Number.NaN };
      expectNames(() => visibleRange(metrics), "clientWidth");
      expectNames(() => thumbFractions(metrics), "clientWidth");
      expectNames(() => dragScroll(metrics, 0, 0, 1200, 500), "clientWidth");
      expectNames(() => trackPressScroll(metrics, 0, 1200, 500), "clientWidth");
      expectNames(() => nearestStop(metrics, 0), "clientWidth");
    });
  });
});
