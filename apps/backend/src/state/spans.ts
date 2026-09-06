/**
 * Interval arithmetic for the time-tracking figures.
 *
 * A span with `end: null` is still running. Nothing here writes an end
 * time: an open span is *read* as ending at the caller's window end, so
 * the row keeps growing until whatever owns it closes it. Writing "now"
 * into the table would turn a live fact into a stale one the moment the
 * process died.
 */
export interface Span {
  start: number;
  end: number | null;
}

/**
 * Restricts spans to `[from, to]`, resolving open spans against `to`.
 *
 * Zero-length results are dropped rather than kept: they contribute
 * nothing to any total, and letting them through would mean every
 * consumer has to filter them again. A stream closed at its own start --
 * one we have no evidence of ever watching -- lands here.
 */
export function clip(spans: Span[], from: number, to: number): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const start = Math.max(span.start, from);
    const end = Math.min(span.end ?? to, to);
    if (end > start) out.push({ start, end });
  }
  return out;
}

/**
 * The overlap between two sets of spans -- "online AND mining".
 *
 * O(n*m) by design. Both inputs are bounded by a day of streams and miner
 * restarts, so a sweep line's bookkeeping would cost more to read than
 * the loop saves to run.
 *
 * Adjacency is not overlap: spans touching at a single instant produce
 * nothing, since `end > start` fails. An overlap of two open spans stays
 * open (Infinity) rather than being resolved here -- only the caller
 * knows what "now" is, and clip() is always applied before any total.
 */
export function intersect(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const left of a) {
    for (const right of b) {
      const start = Math.max(left.start, right.start);
      const end = Math.min(left.end ?? Infinity, right.end ?? Infinity);
      if (end > start) out.push({ start, end });
    }
  }
  return out;
}

/** Total milliseconds covered. Clip first: an unresolved open span
 *  contributes zero here rather than an infinity. */
export function total(spans: Span[]): number {
  return spans.reduce((sum, s) => sum + ((s.end ?? s.start) - s.start), 0);
}
