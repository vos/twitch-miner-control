import { useEffect, useRef, type ReactNode } from "react";

/** How close to the bottom still counts as "following the tail". */
const PIN_SLACK_PX = 40;

export interface LogViewportProps {
  children: ReactNode;
  /**
   * Changes whenever new content arrives, to drive the scroll.
   *
   * A value rather than a callback so the effect below depends on
   * something React can compare: the viewport does not care what changed,
   * only that it did.
   */
  pinKey: unknown;
}

/**
 * The scrolling frame both log views share.
 *
 * Stays pinned to the newest line only while the reader is already at the
 * bottom. Someone who has scrolled up is reading something, and yanking
 * them back to the tail on every pushed frame makes a busy log impossible
 * to read at the exact moment they are trying to.
 */
export function LogViewport({ children, pinKey }: LogViewportProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    if (pinned.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [pinKey]);

  return (
    <div
      ref={viewport}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK_PX;
      }}
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "12px 14px",
        border: "1px solid var(--tw-border)",
        borderRadius: 8,
        background: "var(--tw-bg)",
      }}
    >
      {children}
    </div>
  );
}
