// Page stops for the Episodes rail.
//
// EpisodeRail measures the rail and calls railState and pageTarget. Every
// number is in CSS pixels. Two tolerances: 1 px at the ends (a position
// within 1 px of 0 or of the scroll end counts as that end), and 2 px when
// deciding how many whole tiles fit in the column. A page start within half
// the pitch of the scroll end is dropped, so the last press does not move a
// sliver. At 1024 px with ten tiles the second page step, 1471.68 (2 × 735.84),
// sits 23.32 px before the end and half the pitch is 122.64, so that stop is
// dropped and the last page start is the end, 1495.
//
// visibleRange and countLabel name the whole tiles in the content column.
// thumbFractions sizes and places the thumb. dragScroll and trackPressScroll
// turn a pointer into a scroll offset, and nearestStop snaps that offset to
// a tile start. Page starts are for the arrows. nearestStop's tile starts
// are for the bar.

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
  // Drop a stop within half the pitch of the end. At 1024 px, 1471.68 is
  // 23.32 px before 1495 and half the pitch is 122.64, so it is dropped.
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

function rejectValue(name: string, value: number): never {
  throw new RangeError(`${name} ${value}`);
}

function requireInteger(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    rejectValue(name, value);
  }
}

function requireFinite(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    rejectValue(name, value);
  }
}

// A width the bar can divide by: finite and above 0.
function requireWidth(name: string, value: number): void {
  requireFinite(name, value);
  if (value <= 0) {
    rejectValue(name, value);
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function scrollEnd(metrics: RailMetrics): number {
  return Math.max(0, metrics.scrollWidth - metrics.clientWidth);
}

/**
 * The 1-based numbers of the first and last whole tiles in the content column.
 *
 * Calls railState first, so a bad metric throws that same RangeError. When
 * the row overflows and tileCount is 0, throws a RangeError naming tileCount.
 */
export function visibleRange(metrics: RailMetrics): { first: number; last: number } {
  const state = railState(metrics);
  if (!state.overflows) {
    return { first: Math.min(1, metrics.tileCount), last: metrics.tileCount };
  }
  if (metrics.tileCount === 0) {
    reject("tileCount", metrics.tileCount);
  }
  const first = clamp(
    Math.ceil((metrics.scrollLeft - 2) / metrics.pitch) + 1,
    1,
    metrics.tileCount,
  );
  const last = clamp(
    Math.floor(
      (metrics.scrollLeft +
        metrics.clientWidth -
        metrics.paddingStart -
        metrics.paddingEnd -
        metrics.tileWidth +
        2) /
        metrics.pitch,
    ) + 1,
    first,
    metrics.tileCount,
  );
  return { first, last };
}

/**
 * The count of whole tiles in view. Two numbers are joined by an en dash,
 * and one number stands alone when they are equal.
 *
 * Throws a RangeError naming the argument and its value when an argument
 * is not an integer, when first is below 1, when last is below first, or
 * when last is above total.
 */
export function countLabel(first: number, last: number, total: number): string {
  requireInteger("first", first);
  requireInteger("last", last);
  requireInteger("total", total);
  if (first < 1) {
    rejectValue("first", first);
  }
  if (last < first) {
    rejectValue("last", last);
  }
  if (last > total) {
    rejectValue("last", last);
  }
  if (first < last) {
    return `${first}\u2013${last} of ${total}`;
  }
  return `${first} of ${total}`;
}

/**
 * The thumb's visible fraction of the row, and how far along the track it sits.
 *
 * Calls railState first, so a bad metric throws that same RangeError. A row
 * that fits is the whole track and sits at the start.
 */
export function thumbFractions(metrics: RailMetrics): {
  visible: number;
  progress: number;
} {
  const state = railState(metrics);
  if (!state.overflows) {
    return { visible: 1, progress: 0 };
  }
  const end = scrollEnd(metrics);
  return {
    visible: metrics.clientWidth / metrics.scrollWidth,
    progress: clamp(metrics.scrollLeft / end, 0, 1),
  };
}

/**
 * The scroll offset while a thumb moves deltaX px from startScrollLeft.
 *
 * Checks the pointer arguments first, then calls railState, so a bad metric
 * throws that same RangeError. Throws a RangeError naming the argument and
 * its value when trackWidth or thumbWidth is not a finite number above 0,
 * when thumbWidth is at least trackWidth, when startScrollLeft is not a
 * finite number at least 0, or when deltaX is not finite. Returns 0 when
 * the row fits.
 */
export function dragScroll(
  metrics: RailMetrics,
  startScrollLeft: number,
  deltaX: number,
  trackWidth: number,
  thumbWidth: number,
): number {
  requireWidth("trackWidth", trackWidth);
  requireWidth("thumbWidth", thumbWidth);
  if (thumbWidth >= trackWidth) {
    rejectValue("thumbWidth", thumbWidth);
  }
  requireFinite("startScrollLeft", startScrollLeft);
  if (startScrollLeft < 0) {
    rejectValue("startScrollLeft", startScrollLeft);
  }
  requireFinite("deltaX", deltaX);
  const state = railState(metrics);
  if (!state.overflows) {
    return 0;
  }
  const end = scrollEnd(metrics);
  return clamp(
    startScrollLeft + (deltaX * end) / (trackWidth - thumbWidth),
    0,
    end,
  );
}

/**
 * The scroll offset that puts the thumb's centre at pressX, in px from the
 * track's left edge.
 *
 * Checks the pointer arguments first, then calls railState, so a bad metric
 * throws that same RangeError. Throws a RangeError naming the argument and
 * its value when trackWidth or thumbWidth is not a finite number above 0,
 * when thumbWidth is at least trackWidth, or when pressX is not finite.
 * Returns 0 when the row fits.
 */
export function trackPressScroll(
  metrics: RailMetrics,
  pressX: number,
  trackWidth: number,
  thumbWidth: number,
): number {
  requireWidth("trackWidth", trackWidth);
  requireWidth("thumbWidth", thumbWidth);
  if (thumbWidth >= trackWidth) {
    rejectValue("thumbWidth", thumbWidth);
  }
  requireFinite("pressX", pressX);
  const state = railState(metrics);
  if (!state.overflows) {
    return 0;
  }
  const end = scrollEnd(metrics);
  const span = trackWidth - thumbWidth;
  return (clamp(pressX - thumbWidth / 2, 0, span) / span) * end;
}

/**
 * The tile start nearest scrollLeft, or the scroll end when that is nearer.
 *
 * These are tile starts, for the bar. A tie keeps the lower stop. Checks
 * scrollLeft first, then calls railState, so a bad metric throws that same
 * RangeError. Throws a RangeError naming scrollLeft when it is not finite.
 * Returns 0 when the row fits.
 */
export function nearestStop(metrics: RailMetrics, scrollLeft: number): number {
  requireFinite("scrollLeft", scrollLeft);
  const state = railState(metrics);
  if (!state.overflows) {
    return 0;
  }
  const end = scrollEnd(metrics);
  const target = clamp(scrollLeft, 0, end);
  let best = end;
  let bestDist = Math.abs(target - end);
  for (let k = 0; k < metrics.tileCount; k += 1) {
    const stop = Math.min(k * metrics.pitch, end);
    const dist = Math.abs(target - stop);
    if (dist < bestDist || (dist === bestDist && stop < best)) {
      best = stop;
      bestDist = dist;
    }
  }
  return best;
}
