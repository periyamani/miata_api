import { env } from '../config/env.js';

const dayFmt = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** A calendar date for messages: 'YYYY-MM-DD' → '4 Oct 2026'. */
export const formatDay = (isoDate) => dayFmt.format(new Date(`${isoDate}T00:00:00Z`));

/** Today's calendar date in APP_TIMEZONE as 'YYYY-MM-DD'. */
export const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: env.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** 'YYYY-MM-DD' plus `days` calendar days. */
export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Calendar days from one 'YYYY-MM-DD' to another (negative when `to` is earlier). */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Programme weeks from a start to an end date inclusive (week 1 begins on the start date): 19 Oct 2026 – 18 Apr 2027 → 26. */
export const weeksInRange = (start, end) => Math.ceil((daysBetween(start, end) + 1) / 7);
