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
