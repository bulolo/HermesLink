import Database from "better-sqlite3";

export interface SqliteOptions {
  readonly?: boolean;
  timeout?: number;
}

export function openSqliteDatabase(filePath: string, options: SqliteOptions = {}): Database.Database {
  return new Database(filePath, {
    ...(options.readonly === undefined ? {} : { readonly: options.readonly, fileMustExist: options.readonly }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
}
