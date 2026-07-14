declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement<T = unknown> {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): T | undefined;
    all(...params: unknown[]): T[];
  }

  class Database {
    constructor(filename: string, options?: { readonly?: boolean });
    pragma(source: string, options?: { simple?: boolean }): unknown;
    prepare(sql: string): Statement;
    exec(sql: string): this;
    close(): void;
  }

  namespace Database {
    type Statement<T = unknown> = import("better-sqlite3").Statement<T>;
  }

  export = Database;
}
