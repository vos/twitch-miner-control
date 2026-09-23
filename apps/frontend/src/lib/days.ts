const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day a timestamp falls on, as 'YYYY-MM-DD'. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight at the start of a 'YYYY-MM-DD' day. */
export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Local midnight on the Monday of the week containing `ts`. */
export function mondayOf(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
}
