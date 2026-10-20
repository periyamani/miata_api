const formatters = new Map();

/** 36000 + 'AUD' → 'A$36,000.00' (activity log and notification text; the portals format amounts themselves). */
export function formatMoney(amount, currency) {
  if (!formatters.has(currency)) {
    formatters.set(currency, new Intl.NumberFormat('en-AU', { style: 'currency', currency }));
  }
  return formatters.get(currency).format(Number(amount) || 0);
}
