/**
 * Tiny helper for building parameterised WHERE clauses without string-concatenating values.
 *   const q = new SqlBuilder();
 *   q.where(`u.role = ${q.param('student')}`);
 *   pool.query(`SELECT … ${q.whereClause()}`, q.params)
 */
export class SqlBuilder {
  constructor() {
    this.params = [];
    this.conditions = [];
  }

  param(value) {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  where(condition) {
    this.conditions.push(condition);
    return this;
  }

  /** ILIKE across several columns using one shared parameter. */
  search(term, columns) {
    if (!term) return this;
    const p = this.param(`%${escapeLike(term)}%`);
    return this.where(`(${columns.map((c) => `${c} ILIKE ${p}`).join(' OR ')})`);
  }

  whereClause() {
    return this.conditions.length ? `WHERE ${this.conditions.join(' AND ')}` : '';
  }
}

export const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Resolve a client-supplied sort key against a whitelist; never interpolate user input directly. */
export function orderBy(sort, order, allowed, fallback) {
  const column = allowed[sort] || allowed[fallback];
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${column} ${direction} NULLS LAST`;
}

export const limitOffset = (q, { page, pageSize }) => `LIMIT ${q.param(pageSize)} OFFSET ${q.param((page - 1) * pageSize)}`;

/** Run a list query that selects `count(*) OVER () AS total_count`, returning `{ rows, total }`. */
export async function paged(db, sql, params) {
  const { rows } = await db.query(sql, params);
  const total = rows[0]?.total_count ?? 0;
  return { rows: rows.map(({ total_count: _total, ...r }) => r), total };
}
