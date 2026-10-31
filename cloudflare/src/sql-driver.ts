import type { SqlStorage } from 'cloudflare:workers';
import type { SqlDriver, SqlValue } from '../../backend/src/db.ts';

/**
 * Adapta o SQLite do Durable Object (ctx.storage.sql) à interface usada pelo Store.
 * Documentação: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
 *  - exec(query, ...bindings) → cursor com toArray(), one(), rowsWritten
 *  - PRAGMAs não são necessários (o runtime gerencia o arquivo)
 */
export function doSqlDriver(sql: Pick<SqlStorage, 'exec'>): SqlDriver {
  return {
    exec: (q) => { sql.exec(q).toArray(); },
    prepare: (q) => ({
      get: (...p: SqlValue[]) => sql.exec(q, ...p).toArray()[0],
      all: (...p: SqlValue[]) => sql.exec(q, ...p).toArray(),
      run: (...p: SqlValue[]) => {
        const cur = sql.exec(q, ...p);
        cur.toArray();
        const written = cur.rowsWritten;
        const id = written > 0 ? (sql.exec<{ id: number }>('SELECT last_insert_rowid() AS id').toArray()[0]?.id ?? 0) : 0;
        return { changes: written, lastInsertRowid: id };
      },
    }),
  };
}
