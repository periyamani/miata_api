const toCamel = (key) => key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Convert snake_case DB rows to the camelCase shape used by the API (deep, plain objects only). */
export function camelize(value) {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [toCamel(k), camelize(v)]));
  }
  return value;
}

/** Standard success envelope: `{ data, meta? }`. */
export function send(res, data, { status = 200, meta } = {}) {
  const body = { data: camelize(data) };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

export const created = (res, data) => send(res, data, { status: 201 });

/** Standard paginated envelope from a `{ rows, total }` result. */
export function sendPage(res, { rows, total }, { page, pageSize }) {
  return send(res, rows, {
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  });
}

export const clientIp = (req) => req.ip || req.socket?.remoteAddress || null;
