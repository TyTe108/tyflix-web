// Side arrows for one season's Episodes row on the title page.
//
// EpisodeBrowser renders this around the tiles. It measures the rail before
// paint, on the rail's scroll event, and when a ResizeObserver on the rail
// reports, and it disconnects that observer on unmount. The tiles come in as
// children: a scroll re-renders the arrows from this component's own state,
// and EpisodeBrowser does not re-render, so the same tile elements come back.
// When a measurement hides the arrow that has focus, focus moves to the other
// arrow. When the row fits there are no arrows. A phone's rail is a column,
// so it does not overflow and shows none. The arrows' look and position live
// in styles.css.
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  pageTarget,
  railState,
  type RailMetrics,
} from "../lib/railGeometry";

/**
 * The episodes rail and its side arrows.
 *
 * Renders a frame, the previous button, the rail, and the next button. Neither
 * button is rendered when the row fits, or when a measurement is rejected. A
 * press scrolls to the next or previous page start.
 */
export function EpisodeRail({ children }: { children: ReactNode }) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const prevRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`EpisodeRail: ${message}`);
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
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches
      ? "auto"
      : "smooth";
    rail.scrollTo({ left: pageTarget(metrics, direction), behavior });
  }

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
    </div>
  );
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
