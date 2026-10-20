import { AppError } from '../utils/AppError.js';

export function formatIssues(issues) {
  const fields = {};
  for (const issue of issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

/**
 * Validate and coerce request parts with zod. Parsed values are placed on `req.valid`
 * (Express 5 makes `req.query` read-only, and handlers should only ever use validated input).
 */
export const validate =
  ({ params, query, body }) =>
  (req, _res, next) => {
    const valid = {};
    for (const [part, schema] of Object.entries({ params, query, body })) {
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        throw new AppError(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields', formatIssues(result.error.issues));
      }
      valid[part] = result.data;
    }
    req.valid = valid;
    next();
  };
