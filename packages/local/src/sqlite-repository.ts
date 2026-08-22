/**
 * SQLite KeyValueStore — local-first storage backend.
 *
 * Implements KeyValueStore using Bun's built-in SQLite (bun:sqlite).
 * For Node.js deployments, swap to better-sqlite3 — the API is nearly identical.
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type {
  KeyValueStore,
  CompositeKey,
  ConditionalPutOptions,
  QueryOptions,
  PaginatedResult,
} from '@swarm/core';

export interface SqliteRepositoryOptions {
  dbPath?: string;
  tableName?: string;
}

interface ItemRow {
  pk: string;
  sk: string;
  data: string;
  ttl: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split a DynamoDB SET body by top-level commas (not inside parentheses). */
function splitTopLevelCommas(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++;
    else if (expr[i] === ')') depth--;
    else if (expr[i] === ',' && depth === 0) {
      parts.push(expr.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Update expression translator
// ---------------------------------------------------------------------------

interface UpdateSetClause {
  kind: 'set' | 'coalesceIncr';
  column: string;
  value?: unknown;
  coalesceColumn?: string;
  defaultValue?: unknown;
  increment?: unknown;
}

function translateUpdateExpression(
  updateExpression: string,
  expressionAttributeNames: Record<string, string> | undefined,
  expressionAttributeValues: Record<string, unknown> | undefined,
): UpdateSetClause[] {
  const names = expressionAttributeNames ?? {};
  const values = expressionAttributeValues ?? {};

  const resolveName = (token: string): string => names[token] ?? token;
  const resolveValue = (token: string): unknown => {
    if (token.startsWith(':')) return values[token] ?? null;
    const n = Number(token);
    return Number.isNaN(n) ? token : n;
  };

  const results: UpdateSetClause[] = [];
  const clauses = updateExpression.split(/\b(?=SET\b|REMOVE\b|ADD\b|DELETE\b)/);

  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (trimmed.startsWith('SET')) {
      const body = trimmed.slice(3).trim();
      for (const assignment of splitTopLevelCommas(body)) {
        // Simple: bare-column or #name = :value
        const simpleMatch = assignment.match(/^(#\w+|\w+)\s*=\s*(:\w+)$/);
        if (simpleMatch) {
          results.push({ kind: 'set', column: resolveName(simpleMatch[1]), value: resolveValue(simpleMatch[2]) });
          continue;
        }
        // Coalesce-increment: (bare-column or #name) = if_not_exists(...) + :incr
        const ifnMatch = assignment.match(
          /^(#\w+|\w+)\s*=\s*if_not_exists\s*\(\s*(#\w+|\w+)\s*,\s*(:\w+)\s*\)\s*\+\s*(:\w+)$/,
        );
        if (ifnMatch) {
          results.push({
            kind: 'coalesceIncr',
            column: resolveName(ifnMatch[1]),
            coalesceColumn: resolveName(ifnMatch[2]),
            defaultValue: resolveValue(ifnMatch[3]),
            increment: resolveValue(ifnMatch[4]),
          });
          continue;
        }
        throw new Error(`Unsupported SET assignment: "${assignment}"`);
      }
    } else if (trimmed.startsWith('REMOVE')) {
      for (const col of trimmed.slice(6).trim().split(',').map((s) => s.trim())) {
        results.push({ kind: 'set', column: resolveName(col), value: null });
      }
    } else if (trimmed.startsWith('ADD')) {
      throw new Error('ADD not yet supported in SQLite backend');
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Filter expression translator
// ---------------------------------------------------------------------------

function translateFilter(
  filterExpression: string,
  expressionAttributeValues: Record<string, unknown>,
  expressionAttributeNames: Record<string, string> | undefined,
): { whereClause: string; bindings: Record<string, unknown> } {
  const names = expressionAttributeNames ?? {};
  const bindings: Record<string, unknown> = {};
  let sql = filterExpression;

  // Resolve #name placeholders. If names are provided, map to json_extract.
  // Otherwise strip the # prefix so #name becomes a plain column reference.
  const resolvedNames: Record<string, string> = names ?? {};
  for (const [placeholder, colName] of Object.entries(resolvedNames)) {
    sql = sql.replace(
      new RegExp(placeholder.replace(/#/g, '\\#'), 'g'),
      `json_extract(data, '$.${colName}')`,
    );
  }
  // Strip remaining # prefixes from unresolved placeholders
  sql = sql.replace(/#(\w+)/g, '$1');

  let bindIdx = 0;
  for (const [placeholder, value] of Object.entries(expressionAttributeValues)) {
    const bindName = `_fb_${bindIdx++}`;
    // Replace the placeholder with a bind parameter
    sql = sql.replace(new RegExp(placeholder.replace(/:/g, '\\:'), 'g'), `:${bindName}`);
    bindings[bindName] = value;
  }

  sql = sql.replace(/attribute_exists\(([^)]+)\)/g, '$1 IS NOT NULL');
  sql = sql.replace(/attribute_not_exists\(([^)]+)\)/g, '$1 IS NULL');
  sql = sql.replace(/begins_with\(([^,]+),\s*([^)]+)\)/g, "$1 LIKE ($2 || '%')");

  return { whereClause: sql, bindings };
}

// ---------------------------------------------------------------------------
// SqliteRepository
// ---------------------------------------------------------------------------

export class SqliteRepository implements KeyValueStore {
  private db: Database;
  private tableName: string;
  private _lastCleanup: number = 0;

  constructor(options: SqliteRepositoryOptions = {}) {
    this.db = new Database(options.dbPath ?? ':memory:');
    this.tableName = options.tableName ?? 'items';
    this.db.run('PRAGMA journal_mode = WAL');
    this._ensureTable();
  }

  private _ensureTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS "${this.tableName}" (
        pk TEXT NOT NULL,
        sk TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        ttl INTEGER,
        PRIMARY KEY (pk, sk)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS i_${this.tableName}_pk ON "${this.tableName}"(pk)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS i_${this.tableName}_ttl ON "${this.tableName}"(ttl)`);
  }

  close(): void { this.db.close(); }

  cleanupExpired(): number {
    return this.db
      .prepare(`DELETE FROM "${this.tableName}" WHERE ttl IS NOT NULL AND ttl <= ?`)
      .run(Math.floor(Date.now() / 1000))
      .changes;
  }

  // ---- KeyValueStore ----

  async get<T extends Record<string, unknown> = Record<string, unknown>>(
    key: CompositeKey,
    opts?: { projectionExpression?: string; expressionAttributeNames?: Record<string, string> },
  ): Promise<T | null> {
    this._expireRow(key);
    const row = this.db
      .prepare(`SELECT data FROM "${this.tableName}" WHERE pk = ? AND sk = ?`)
      .get(key.pk, key.sk) as ItemRow | undefined;
    if (!row) return null;
    let item = { ...JSON.parse(row.data), pk: key.pk, sk: key.sk } as Record<string, unknown>;
    if (opts?.projectionExpression) {
      item = this._applyProjection(item, opts.projectionExpression, opts.expressionAttributeNames);
    }
    return item as T;
  }

  async put(
    item: Record<string, unknown> & CompositeKey,
    options?: ConditionalPutOptions,
  ): Promise<boolean> {
    const { pk, sk, ...rest } = item;
    const ttl = typeof rest.ttl === 'number' ? rest.ttl : null;
    const condExpr = options?.conditionExpression;

    if (options?.onlyIfNotExists || condExpr?.includes('attribute_not_exists(pk)')) {
      const exists = this.db
        .prepare(`SELECT 1 FROM "${this.tableName}" WHERE pk = ? AND sk = ?`)
        .get(pk, sk);
      if (exists) return false;
    } else if (condExpr) {
      throw new Error(`Unsupported condition: "${condExpr}"`);
    }

    this.db
      .prepare(`INSERT OR REPLACE INTO "${this.tableName}" (pk, sk, data, ttl) VALUES (?, ?, ?, ?)`)
      .run(pk, sk, JSON.stringify(rest), ttl);
    return true;
  }

  async delete(key: CompositeKey): Promise<void> {
    this.db.prepare(`DELETE FROM "${this.tableName}" WHERE pk = ? AND sk = ?`).run(key.pk, key.sk);
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    pk: string,
    options?: QueryOptions,
  ): Promise<T[]> {
    const result = await this.queryPage<T>(pk, options);
    return result.items;
  }

  async queryPage<T extends Record<string, unknown> = Record<string, unknown>>(
    pk: string,
    options?: QueryOptions,
    exclusiveStartKey?: Record<string, unknown>,
  ): Promise<PaginatedResult<T>> {
    this._cleanupExpiredSoft();
    const pkPrefix = (options as (QueryOptions & { pkPrefix?: string }) | undefined)?.pkPrefix;
    const params: SQLQueryBindings[] = [];
    let sql = `SELECT pk, sk, data FROM "${this.tableName}" WHERE `;
    if (pkPrefix) {
      sql += 'pk LIKE ?';
      params.push(`${pkPrefix}%`);
    } else {
      sql += 'pk = ?';
      params.push(pk);
    }

    if (options?.skCondition) {
      if (options.skCondition.type === 'begins_with') {
        sql += ' AND sk LIKE ?';
        params.push(`${options.skCondition.value}%`);
      } else {
        sql += ' AND sk = ?';
        params.push(options.skCondition.value);
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    sql += ` AND (ttl IS NULL OR ttl > ${nowSec})`;

    if (options?.filterExpression) {
      const { whereClause, bindings: fb } = translateFilter(
        options.filterExpression,
        options.expressionAttributeValues ?? {},
        options.expressionAttributeNames,
      );
      if (whereClause) {
        sql += ` AND (${whereClause})`;
        params.push(...(Object.values(fb) as SQLQueryBindings[]));
      }
    }

    const scanFwd = options?.scanForward ?? true;

    if (exclusiveStartKey) {
      if (typeof exclusiveStartKey.sk !== 'string') {
        throw new TypeError('exclusiveStartKey.sk must be a string');
      }
      sql += scanFwd ? ' AND sk > ?' : ' AND sk < ?';
      params.push(exclusiveStartKey.sk);
    }

    sql += ` ORDER BY sk ${scanFwd ? 'ASC' : 'DESC'}`;

    const limit = options?.limit;
    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit + 1);
    }

    const rows = this.db.prepare(sql).all(...params) as ItemRow[];
    const hasMore = limit ? rows.length > limit : false;
    if (hasMore) rows.pop();

    return {
      items: rows.map((row) => ({ ...JSON.parse(row.data), pk: row.pk, sk: row.sk } as unknown as T)),
      lastEvaluatedKey: hasMore && rows.length > 0 ? { pk, sk: rows[rows.length - 1].sk } : undefined,
    };
  }

  async queryAll<T extends Record<string, unknown> = Record<string, unknown>>(
    pk: string,
    options?: QueryOptions,
  ): Promise<T[]> {
    const allItems: T[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const page = await this.queryPage<T>(pk, options, lastKey);
      allItems.push(...page.items);
      lastKey = page.lastEvaluatedKey;
    } while (lastKey);
    return allItems;
  }

  async update<T extends Record<string, unknown> = Record<string, unknown>>(
    key: CompositeKey,
    params: {
      updateExpression: string;
      expressionAttributeNames?: Record<string, string>;
      expressionAttributeValues?: Record<string, unknown>;
      conditionExpression?: string;
      returnValues?: 'ALL_NEW' | 'ALL_OLD' | 'UPDATED_NEW' | 'UPDATED_OLD' | 'NONE';
    },
  ): Promise<T | null> {
    this._expireRow(key);
    const clauses = translateUpdateExpression(
      params.updateExpression,
      params.expressionAttributeNames,
      params.expressionAttributeValues,
    );
    if (clauses.length === 0) throw new Error('No update clauses produced');

    const row = this.db
      .prepare(`SELECT data FROM "${this.tableName}" WHERE pk = ? AND sk = ?`)
      .get(key.pk, key.sk) as ItemRow | undefined;
    const data: Record<string, unknown> = row ? JSON.parse(row.data) : {};
    const returnOld = params.returnValues === 'ALL_OLD' || params.returnValues === 'UPDATED_OLD';

    for (const clause of clauses) {
      if (clause.kind === 'set') {
        data[clause.column] = clause.value ?? undefined;
      } else if (clause.kind === 'coalesceIncr') {
        const cur = data[clause.coalesceColumn!];
        const base = cur != null ? Number(cur) : Number(clause.defaultValue);
        data[clause.column] = base + Number(clause.increment);
      }
    }

    const ttl = typeof data.ttl === 'number' ? data.ttl : null;
    this.db
      .prepare(`INSERT OR REPLACE INTO "${this.tableName}" (pk, sk, data, ttl) VALUES (?, ?, ?, ?)`)
      .run(key.pk, key.sk, JSON.stringify(data), ttl);

    if (returnOld || params.returnValues === 'ALL_OLD' || params.returnValues === 'UPDATED_OLD') {
      return { ...data, pk: key.pk, sk: key.sk } as unknown as T;
    }
    if (params.returnValues === 'ALL_NEW' || params.returnValues === 'UPDATED_NEW') {
      return { ...data, pk: key.pk, sk: key.sk } as unknown as T;
    }
    return null;
  }

  async batchWrite(
    operations: Array<
      | { type: 'put'; item: Record<string, unknown> & CompositeKey }
      | { type: 'delete'; key: CompositeKey }
    >,
  ): Promise<void> {
    if (operations.length === 0) return;
    if (operations.length > 25) throw new Error(`batchWrite max 25, got ${operations.length}`);

    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO "${this.tableName}" (pk, sk, data, ttl) VALUES (?, ?, ?, ?)`,
    );
    const del = this.db.prepare(`DELETE FROM "${this.tableName}" WHERE pk = ? AND sk = ?`);
    this.db.transaction(() => {
      for (const op of operations) {
        if (op.type === 'put') {
          const { pk, sk, ttl, ...rest } = op.item;
          insert.run(pk, sk, JSON.stringify(rest), typeof ttl === 'number' ? ttl : null);
        } else {
          del.run(op.key.pk, op.key.sk);
        }
      }
    })();
  }

  async scan<T extends Record<string, unknown> = Record<string, unknown>>(
    params: {
      filterExpression: string;
      expressionAttributeValues: Record<string, unknown>;
      expressionAttributeNames?: Record<string, string>;
      projectionExpression?: string;
      limit?: number;
    },
  ): Promise<T[]> {
    this._cleanupExpiredSoft();
    let sql = `SELECT pk, sk, data FROM "${this.tableName}"`;
    const bindParams: SQLQueryBindings[] = [];

    const { whereClause, bindings } = translateFilter(
      params.filterExpression,
      params.expressionAttributeValues,
      params.expressionAttributeNames,
    );

    const conditions: string[] = [];
    if (whereClause) {
      conditions.push(`(${whereClause})`);
      bindParams.push(...(Object.values(bindings) as SQLQueryBindings[]));
    }
    const ttlClause = `(ttl IS NULL OR ttl > ${Math.floor(Date.now() / 1000)})`;
    conditions.push(ttlClause);

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    if (params.limit) {
      sql += ' LIMIT ?';
      bindParams.push(params.limit);
    }

    const rows = this.db.prepare(sql).all(...bindParams) as ItemRow[];
    return rows.map((row) => ({ ...JSON.parse(row.data), pk: row.pk, sk: row.sk } as unknown as T));
  }

  // ---- Internal ----

  private _expireRow(key: CompositeKey): void {
    const row = this.db
      .prepare(`SELECT ttl FROM "${this.tableName}" WHERE pk = ? AND sk = ?`)
      .get(key.pk, key.sk) as { ttl: number | null } | undefined;
    if (row?.ttl && row.ttl <= Math.floor(Date.now() / 1000)) {
      this.db.prepare(`DELETE FROM "${this.tableName}" WHERE pk = ? AND sk = ?`).run(key.pk, key.sk);
    }
  }

  private _cleanupExpiredSoft(): void {
    const now = Date.now();
    if (now - this._lastCleanup > 60_000) {
      this._lastCleanup = now;
      this.cleanupExpired();
    }
  }

  private _applyProjection(
    item: Record<string, unknown>,
    expr: string,
    names?: Record<string, string>,
  ): Record<string, unknown> {
    const map = names ?? {};
    const result: Record<string, unknown> = { pk: item.pk, sk: item.sk };
    for (const field of expr.split(',').map((s) => s.trim())) {
      const resolved = map[field] ?? field;
      if (resolved in item) result[resolved] = item[resolved];
    }
    return result;
  }
}
