// Page stops for the Episodes rail.
//
// EpisodeRail measures the rail and calls railState and pageTarget. Every
// number is in CSS pixels. Two tolerances: 1 px at the ends (a position
// within 1 px of 0 or of the scroll end counts as that end), and 2 px when
// deciding how many whole tiles fit in the column. A page start within half
// a tile of the scroll end is dropped, so the last press does not move a
// sliver. At 1024 px with ten tiles the second page step, 1471.68 (2 × 735.84),
// sits 23.32 px before the end and half a tile is 122.64, so that stop is
// dropped and the last page start is the end, 1495.

/**
 * Measured size of one rail, in CSS pixels.
 *
 * tileCount is how many element children the rail has. pitch is the distance
 * from one tile's left edge to the next one's.
 */
export type RailMetrics = {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  paddingStart: number;
  paddingEnd: number;
  tileWidth: number;
  pitch: number;
  tileCount: number;
};

/**
 * What the arrows do with one measurement.
 *
 * overflows is false when the row fits. page is an index into pageStarts.
 * pageStarts begins at 0, and when the row overflows it ends at the scroll end.
 */
export type RailState = {
  overflows: boolean;
  atStart: boolean;
  atEnd: boolean;
  page: number;
  pageStarts: number[];
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

function reject(field: keyof RailMetrics, value: number): never {
  throw new RangeError(`${field} ${value}`);
}

/**
 * Page stops and which one the rail is on.
 *
 * Throws a RangeError naming the field and its value when a metric is not a
 * finite number greater than or equal to 0, when tileCount is not an integer,
 * or, when the rail overflows, when tileWidth or pitch is 0.
 */
export function railState(metrics: RailMetrics): RailState {
  for (const field of FIELDS) {
    const value = metrics[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      reject(field, value);
    }
  }
  if (!Number.isInteger(metrics.tileCount)) {
    reject("tileCount", metrics.tileCount);
  }

  const end = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  // 1 px at the ends: a gap of 1 px or less is a row that fits.
  const overflows = end > 1;
  if (!overflows) {
    return {
      overflows: false,
      atStart: true,
      atEnd: true,
      page: 0,
      pageStarts: [0],
    };
  }
  if (metrics.tileWidth === 0) {
    reject("tileWidth", metrics.tileWidth);
  }
  if (metrics.pitch === 0) {
    reject("pitch", metrics.pitch);
  }

  // 2 px of slack so a row of whole tiles that is a hair wider than the
  // column still counts as one page. At 1440 px, four tiles need 1320.8 px
  // of a 1320 px column.
  const perPage = Math.max(
    1,
    Math.floor(
      (metrics.clientWidth -
        metrics.paddingStart -
        metrics.paddingEnd +
        (metrics.pitch - metrics.tileWidth) +
        2) /
        metrics.pitch,
    ),
  );
  const step = perPage * metrics.pitch;
  const pageStarts = [0];
  // Drop a stop within half a tile of the end. At 1024 px, 1471.68 is
  // 23.32 px before 1495 and half a tile is 122.64, so it is dropped.
  const lastKept = end - metrics.pitch / 2;
  for (let k = 1; k * step < lastKept; k += 1) {
    pageStarts.push(k * step);
  }
  pageStarts.push(end);

  const atStart = metrics.scrollLeft <= 1;
  const atEnd = metrics.scrollLeft >= end - 1;
  let page = pageStarts.length - 1;
  if (!atEnd) {
    page = 0;
    const seen = metrics.scrollLeft + 2;
    for (let index = 0; index < pageStarts.length - 1; index += 1) {
      const start = pageStarts[index];
      if (start !== undefined && start <= seen) {
        page = index;
      }
    }
  }

  return { overflows: true, atStart, atEnd, page, pageStarts };
}

/**
 * The scroll offset one press should land on.
 *
 * direction -1 is the previous page start and 1 is the next. The index stays
 * inside pageStarts.
 */
export function pageTarget(metrics: RailMetrics, direction: -1 | 1): number {
  const { page, pageStarts } = railState(metrics);
  const last = pageStarts.length - 1;
  const index = Math.min(last, Math.max(0, page + direction));
  const target = pageStarts[index];
  if (target === undefined) {
    throw new RangeError(`page ${index}`);
  }
  return target;
}
