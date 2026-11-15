// Side arrows, and Tyflix's scroll bar, for one season's Episodes row.
//
// EpisodeBrowser renders this around the tiles. It measures the rail before
// paint, on the rail's scroll event, and when a ResizeObserver on the rail
// reports, and it disconnects that observer on unmount. The tiles come in as
// children: a scroll re-renders the arrows and the bar from this component's
// own state, and EpisodeBrowser does not re-render, so the same tile elements
// come back. When a measurement hides the arrow that has focus, focus moves
// to the other arrow. When the row fits there are no arrows, no bar and no
// count. A phone's rail is a column, so it does not overflow and shows none.
// The arrows' look and the bar's look live in styles.css.
//
// A drag captures the pointer on the track and turns snapping off while the
// thumb moves, then scrolls to the nearest tile start. A press on the track
// settles the same way. The track is aria-hidden because the arrows, Tab and
// the wheel already cover it. The count is not a live region, because that
// would speak on every scroll.
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
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
} from "../lib/railGeometry";

/**
 * The episodes rail, its side arrows, and the scroll bar under it.
 *
 * Renders a frame, the previous button, the rail, the next button, then the
 * bar and the count. None of those controls are rendered when the row fits,
 * or when a measurement is rejected. A press on an arrow scrolls to the next
 * or previous page start. A drag of the thumb captures the pointer on the
 * track, turns snapping off, and then settles on the nearest tile start. A
 * press on the track settles the same way. The track is aria-hidden because
 * the arrows, Tab and the wheel already cover it. The count is not a live
 * region, because that would speak on every scroll.
 */
export function EpisodeRail({ children }: { children: ReactNode }) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const prevRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [metrics, setMetrics] = useState<RailMetrics | null>(null);
  const [invalid, setInvalid] = useState(false);

  const measure = useCallback(() => {
    const rail = railRef.current;
    if (rail === null) {
      return;
    }
    let next: RailMetrics;
    try {
      next = readMetrics(rail);
      railState(next);
      visibleRange(next);
      thumbFractions(next);
    } catch (err) {
      reportRailError(err);
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setMetrics(next);
  }, []);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (rail === null) {
      return;
    }
    measure();
    rail.addEventListener("scroll", measure);
    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(rail);
    return () => {
      rail.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);

  useLayoutEffect(() => {
    if (invalid || metrics === null) {
      return;
    }
    // metrics was accepted in measure, so this does not throw.
    const state = railState(metrics);
    if (!state.overflows) {
      return;
    }
    if (
      state.atStart &&
      prevRef.current !== null &&
      document.activeElement === prevRef.current
    ) {
      nextRef.current?.focus();
    } else if (
      state.atEnd &&
      nextRef.current !== null &&
      document.activeElement === nextRef.current
    ) {
      prevRef.current?.focus();
    }
  }, [invalid, metrics]);

  const state = !invalid && metrics !== null ? railState(metrics) : null;
  const overflows = state !== null && state.overflows;

  function onPress(direction: -1 | 1): void {
    const rail = railRef.current;
    if (rail === null || metrics === null || state === null || !overflows) {
      return;
    }
    const behavior = scrollBehavior();
    rail.scrollTo({ left: pageTarget(metrics, direction), behavior });
  }

  function endDrag(rail: HTMLElement): void {
    dragRef.current = null;
    rail.style.scrollSnapType = "";
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || metrics === null) {
      return;
    }
    const rail = railRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (rail === null || track === null || thumb === null) {
      return;
    }
    const trackRect = track.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    if (event.target === thumb) {
      event.preventDefault();
      rail.style.scrollSnapType = "none";
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startScrollLeft: rail.scrollLeft,
        trackWidth: trackRect.width,
        thumbWidth: thumbRect.width,
      };
      try {
        track.setPointerCapture(event.pointerId);
      } catch (err) {
        endDrag(rail);
        reportRailError(err);
      }
      return;
    }
    event.preventDefault();
    try {
      const pressX = event.clientX - trackRect.left;
      rail.scrollTo({
        left: nearestStop(
          metrics,
          trackPressScroll(metrics, pressX, trackRect.width, thumbRect.width),
        ),
        behavior: scrollBehavior(),
      });
    } catch (err) {
      endDrag(rail);
      reportRailError(err);
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    const rail = railRef.current;
    if (drag === null || rail === null || metrics === null || event.pointerId !== drag.pointerId) {
      return;
    }
    try {
      rail.scrollLeft = dragScroll(
        metrics,
        drag.startScrollLeft,
        event.clientX - drag.startX,
        drag.trackWidth,
        drag.thumbWidth,
      );
    } catch (err) {
      endDrag(rail);
      reportRailError(err);
    }
  }

  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    const rail = railRef.current;
    if (drag === null || rail === null || metrics === null || event.pointerId !== drag.pointerId) {
      return;
    }
    const scrollLeft = rail.scrollLeft;
    endDrag(rail);
    try {
      rail.scrollTo({
        left: nearestStop(metrics, scrollLeft),
        behavior: scrollBehavior(),
      });
    } catch (err) {
      reportRailError(err);
    }
  }

  const range = overflows && metrics !== null ? visibleRange(metrics) : null;
  const fractions = overflows && metrics !== null ? thumbFractions(metrics) : null;

  return (
    <div className="episode-rail-frame">
      {overflows && state !== null ? (
        <ArrowButton
          key="prev"
          direction={-1}
          hidden={state.atStart}
          buttonRef={prevRef}
          onPress={onPress}
        />
      ) : null}
      <div key="rail" className="episode-rail" ref={railRef}>
        {children}
      </div>
      {overflows && state !== null ? (
        <ArrowButton
          key="next"
          direction={1}
          hidden={state.atEnd}
          buttonRef={nextRef}
          onPress={onPress}
        />
      ) : null}
      {range !== null && fractions !== null && metrics !== null ? (
        <div key="bar" className="episode-rail-scrollbar">
          <div
            className="episode-rail-track"
            aria-hidden="true"
            ref={trackRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
          >
            <div
              className="episode-rail-thumb"
              ref={thumbRef}
              style={thumbStyle(fractions)}
            />
          </div>
          <p className="episode-rail-count">
            {countLabel(range.first, range.last, metrics.tileCount)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

type Drag = {
  pointerId: number;
  startX: number;
  startScrollLeft: number;
  trackWidth: number;
  thumbWidth: number;
};

function reportRailError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`EpisodeRail: ${message}`);
}

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function thumbStyle(fractions: { visible: number; progress: number }): CSSProperties {
  return {
    "--rail-visible": fractions.visible,
    "--rail-progress": fractions.progress,
  } as CSSProperties;
}

function ArrowButton({
  direction,
  hidden,
  buttonRef,
  onPress,
}: {
  direction: -1 | 1;
  hidden: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onPress: (direction: -1 | 1) => void;
}) {
  const className = hidden
    ? `episode-rail-arrow episode-rail-arrow--${direction === -1 ? "prev" : "next"} is-hidden`
    : `episode-rail-arrow episode-rail-arrow--${direction === -1 ? "prev" : "next"}`;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={className}
      aria-label={direction === -1 ? "Previous episodes" : "Next episodes"}
      aria-hidden={hidden ? true : undefined}
      tabIndex={hidden ? -1 : undefined}
      onClick={() => {
        onPress(direction);
      }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={direction === -1 ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"} />
      </svg>
    </button>
  );
}

function readMetrics(rail: HTMLElement): RailMetrics {
  const style = getComputedStyle(rail);
  const first = rail.firstElementChild;
  const second = first?.nextElementSibling ?? null;
  const firstRect = first?.getBoundingClientRect();
  const tileWidth = firstRect?.width ?? 0;
  const pitch =
    firstRect !== undefined && second !== null
      ? second.getBoundingClientRect().left - firstRect.left
      : tileWidth;
  return {
    scrollLeft: rail.scrollLeft,
    scrollWidth: rail.scrollWidth,
    clientWidth: rail.clientWidth,
    paddingStart: parseFloat(style.paddingLeft),
    paddingEnd: parseFloat(style.paddingRight),
    tileWidth,
    pitch,
    tileCount: rail.children.length,
  };
}
