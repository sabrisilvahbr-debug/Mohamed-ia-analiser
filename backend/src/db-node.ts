import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Store, type SqlDriver } from './db.ts';

/** Driver node:sqlite (Node 22+). */
export function nodeSqlDriver(file: string): SqlDriver {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const st = db.prepare(sql);
      return {
        get: (...p) => st.get(...p),
        all: (...p) => st.all(...p),
        run: (...p) => { const r = st.run(...p); return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }; },
      };
    },
    close: () => db.close(),
  };
}

export function openStore(file: string): Store {
  return new Store(nodeSqlDriver(file));
}
