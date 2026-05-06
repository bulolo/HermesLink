import { mkdir } from "fs/promises";
import path from "path";
import type Database from "better-sqlite3";
import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import { openSqliteDatabase } from "./sqlite.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConversationStatsRecord {
  conversationId: string;
  kind: string;
  title: string;
  status: string;
  hermesSessionId: string;
  profileUid?: string | null;
  profileNameSnapshot?: string | null;
  profile?: string | null;
  model?: string | null;
  provider?: string | null;
  contextWindow?: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  statsUpdatedAt: string;
}

export interface RunUsageFactRecord {
  runId: string;
  conversationId: string;
  profileUid?: string | null;
  profileNameSnapshot?: string | null;
  profile?: string | null;
  model?: string | null;
  provider?: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  startedAt: string;
  completedAt: string;
  updatedAt: string;
}

export interface ConversationCursor {
  updatedAt: string;
  conversationId: string;
}

export interface StatisticsFilter {
  from?: string;
  to?: string;
  model?: string;
  profile?: string;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initLinkDatabase(paths: RuntimePaths): Promise<void> {
  await mkdir(path.dirname(paths.databaseFile), { recursive: true, mode: 0o700 });
  const db = openDb(paths);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS conversation_stats (
        conversation_id   TEXT PRIMARY KEY,
        kind              TEXT NOT NULL,
        title             TEXT NOT NULL,
        status            TEXT NOT NULL,
        hermes_session_id TEXT NOT NULL,
        profile_uid       TEXT,
        profile_name_snapshot TEXT,
        profile           TEXT,
        model             TEXT,
        provider          TEXT,
        context_window    INTEGER,
        input_tokens      INTEGER NOT NULL DEFAULT 0,
        output_tokens     INTEGER NOT NULL DEFAULT 0,
        total_tokens      INTEGER NOT NULL DEFAULT 0,
        message_count     INTEGER NOT NULL DEFAULT 0,
        run_count         INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        deleted_at        TEXT,
        stats_updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_stats_status
        ON conversation_stats(status);
      CREATE INDEX IF NOT EXISTS idx_conversation_stats_updated_at
        ON conversation_stats(updated_at);
      CREATE INDEX IF NOT EXISTS idx_conversation_stats_model
        ON conversation_stats(model);
      CREATE INDEX IF NOT EXISTS idx_conversation_stats_profile
        ON conversation_stats(profile);
      CREATE INDEX IF NOT EXISTS idx_conversation_stats_profile_uid
        ON conversation_stats(profile_uid);
      CREATE INDEX IF NOT EXISTS idx_conversation_stats_profile_name_snapshot
        ON conversation_stats(profile_name_snapshot);

      CREATE TABLE IF NOT EXISTS profile_registry (
        profile_uid   TEXT PRIMARY KEY,
        profile_name  TEXT NOT NULL UNIQUE,
        profile_path  TEXT NOT NULL,
        display_name  TEXT,
        description   TEXT,
        avatar_type   TEXT NOT NULL DEFAULT 'default',
        avatar_url    TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_profile_registry_profile_name
        ON profile_registry(profile_name);

      CREATE TABLE IF NOT EXISTS run_usage_facts (
        run_id                TEXT PRIMARY KEY,
        conversation_id       TEXT NOT NULL,
        profile_uid           TEXT,
        profile_name_snapshot TEXT,
        profile               TEXT,
        model                 TEXT,
        provider              TEXT,
        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        total_tokens          INTEGER NOT NULL DEFAULT 0,
        message_count         INTEGER NOT NULL DEFAULT 0,
        started_at            TEXT NOT NULL,
        completed_at          TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_usage_facts_completed_at
        ON run_usage_facts(completed_at);
      CREATE INDEX IF NOT EXISTS idx_run_usage_facts_conversation_id
        ON run_usage_facts(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_run_usage_facts_model
        ON run_usage_facts(model);
      CREATE INDEX IF NOT EXISTS idx_run_usage_facts_profile_uid
        ON run_usage_facts(profile_uid);
      CREATE INDEX IF NOT EXISTS idx_run_usage_facts_profile_name_snapshot
        ON run_usage_facts(profile_name_snapshot);
    `);
  } finally {
    db.close();
  }
}

// ─── Conversation Stats ───────────────────────────────────────────────────────

export async function upsertConversationStats(
  paths: RuntimePaths,
  record: ConversationStatsRecord,
): Promise<void> {
  await initLinkDatabase(paths);
  const db = openDb(paths);
  try {
    db.prepare(conversationStatsUpsertSql()).run(...conversationStatsParams(record));
  } finally {
    db.close();
  }
}

export async function replaceConversationStatsIndex(
  paths: RuntimePaths,
  records: ConversationStatsRecord[],
): Promise<void> {
  await initLinkDatabase(paths);
  const db = openDb(paths);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM conversation_stats");
      const stmt = db.prepare(conversationStatsUpsertSql());
      for (const record of records) stmt.run(...conversationStatsParams(record));
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function listConversationStatsPage(
  paths: RuntimePaths,
  input: { limit?: number; cursor?: ConversationCursor },
): Promise<{ records: ConversationCursor[]; hasMore: boolean }> {
  await initLinkDatabase(paths);
  const rawLimit = Number.isFinite(input.limit) ? Math.trunc(input.limit!) : 25;
  const limit = Math.max(1, Math.min(100, rawLimit));
  const db = openDb(paths);
  try {
    const conditions = ["status = ?"];
    const params: unknown[] = ["active"];
    if (input.cursor) {
      conditions.push(`(updated_at < ? OR (updated_at = ? AND conversation_id < ?))`);
      params.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.conversationId);
    }
    const rows = db
      .prepare(
        `SELECT conversation_id, updated_at FROM conversation_stats
         WHERE ${conditions.join(" AND ")}
         ORDER BY updated_at DESC, conversation_id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as Record<string, unknown>[];
    const records = rows
      .slice(0, limit)
      .map((row) => ({ conversationId: readString(row, "conversation_id") ?? "", updatedAt: readString(row, "updated_at") ?? "" }))
      .filter((r) => r.conversationId && r.updatedAt);
    return { records, hasMore: rows.length > limit };
  } finally {
    db.close();
  }
}

export async function searchConversationStatsPage(
  paths: RuntimePaths,
  input: { query: string; limit?: number; cursor?: ConversationCursor },
): Promise<{ records: ConversationCursor[]; hasMore: boolean }> {
  await initLinkDatabase(paths);
  const rawLimit = Number.isFinite(input.limit) ? Math.trunc(input.limit!) : 25;
  const limit = Math.max(1, Math.min(100, rawLimit));
  const query = input.query.trim();
  if (!query) return listConversationStatsPage(paths, { limit, cursor: input.cursor });
  const db = openDb(paths);
  try {
    const conditions = ["status = ?", "LOWER(title) LIKE ? ESCAPE '\\'"];
    const params: unknown[] = ["active", `%${escapeSqlLike(query.toLowerCase())}%`];
    if (input.cursor) {
      conditions.push(`(updated_at < ? OR (updated_at = ? AND conversation_id < ?))`);
      params.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.conversationId);
    }
    const rows = db
      .prepare(
        `SELECT conversation_id, updated_at FROM conversation_stats
         WHERE ${conditions.join(" AND ")}
         ORDER BY updated_at DESC, conversation_id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as Record<string, unknown>[];
    const records = rows
      .slice(0, limit)
      .map((row) => ({ conversationId: readString(row, "conversation_id") ?? "", updatedAt: readString(row, "updated_at") ?? "" }))
      .filter((r) => r.conversationId && r.updatedAt);
    return { records, hasMore: rows.length > limit };
  } finally {
    db.close();
  }
}

// ─── Run Usage Facts ──────────────────────────────────────────────────────────

export async function upsertRunUsageFact(
  paths: RuntimePaths,
  record: RunUsageFactRecord,
): Promise<void> {
  await initLinkDatabase(paths);
  const db = openDb(paths);
  try {
    db.prepare(runUsageFactUpsertSql()).run(...runUsageFactParams(record));
  } finally {
    db.close();
  }
}

export async function replaceRunUsageFactsForConversation(
  paths: RuntimePaths,
  conversationId: string,
  records: RunUsageFactRecord[],
): Promise<void> {
  await initLinkDatabase(paths);
  const db = openDb(paths);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM run_usage_facts WHERE conversation_id = ?").run(conversationId);
      const stmt = db.prepare(runUsageFactUpsertSql());
      for (const record of records) stmt.run(...runUsageFactParams(record));
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }
  } finally {
    db.close();
  }
}

// ─── Statistics ───────────────────────────────────────────────────────────────

export async function readLinkStatistics(
  paths: RuntimePaths,
  filter: StatisticsFilter = {},
): Promise<Record<string, unknown>> {
  await initLinkDatabase(paths);
  const db = openDb(paths);
  try {
    const convWhere = statisticsWhereClause(filter);
    const usageWhere = runUsageWhereClause(filter);

    const convRow = db
      .prepare(
        `SELECT COUNT(*) AS total_conversations,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_conversations,
                SUM(CASE WHEN status <> 'active' THEN 1 ELSE 0 END) AS deleted_conversations,
                MAX(stats_updated_at) AS updated_at
         FROM conversation_stats ${convWhere.sql}`,
      )
      .get(...convWhere.params) as Record<string, unknown>;

    const usageRow = db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(SUM(message_count), 0) AS message_count,
                COUNT(*) AS run_count,
                MAX(updated_at) AS updated_at
         FROM run_usage_facts ${usageWhere.sql}`,
      )
      .get(...usageWhere.params) as Record<string, unknown>;

    const updatedAt = readString(usageRow, "updated_at") ?? readString(convRow, "updated_at");
    return {
      conversations: {
        total: readNumber(convRow, "total_conversations"),
        active: readNumber(convRow, "active_conversations"),
        deleted: readNumber(convRow, "deleted_conversations"),
      },
      tokens: {
        input_tokens: readNumber(usageRow, "input_tokens"),
        output_tokens: readNumber(usageRow, "output_tokens"),
        total_tokens: readNumber(usageRow, "total_tokens"),
      },
      messages: { total: readNumber(usageRow, "message_count") },
      runs: { total: readNumber(usageRow, "run_count") },
      ...(updatedAt ? { updated_at: updatedAt } : {}),
    };
  } finally {
    db.close();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function openDb(paths: RuntimePaths): Database.Database {
  const db = openSqliteDatabase(paths.databaseFile, { timeout: 5000 });
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  return db;
}

function rollback(db: Database.Database): void {
  try { db.exec("ROLLBACK"); } catch {}
}

function readNumber(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function readString(row: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = row?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

function statisticsWhereClause(filter: StatisticsFilter): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.from) { conditions.push("stats_updated_at >= ?"); params.push(filter.from); }
  if (filter.to) { conditions.push("stats_updated_at < ?"); params.push(filter.to); }
  if (filter.model) { conditions.push("model = ?"); params.push(filter.model); }
  if (filter.profile) { conditions.push("profile = ?"); params.push(filter.profile); }
  return { sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

function runUsageWhereClause(filter: StatisticsFilter): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.from) { conditions.push("completed_at >= ?"); params.push(filter.from); }
  if (filter.to) { conditions.push("completed_at < ?"); params.push(filter.to); }
  if (filter.model) { conditions.push("model = ?"); params.push(filter.model); }
  if (filter.profile) { conditions.push("profile = ?"); params.push(filter.profile); }
  return { sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

function conversationStatsUpsertSql(): string {
  return `
    INSERT INTO conversation_stats (
      conversation_id, kind, title, status, hermes_session_id,
      profile_uid, profile_name_snapshot, profile, model, provider, context_window,
      input_tokens, output_tokens, total_tokens, message_count, run_count,
      created_at, updated_at, deleted_at, stats_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      kind = excluded.kind, title = excluded.title, status = excluded.status,
      hermes_session_id = excluded.hermes_session_id,
      profile_uid = excluded.profile_uid,
      profile_name_snapshot = excluded.profile_name_snapshot,
      profile = excluded.profile, model = excluded.model, provider = excluded.provider,
      context_window = excluded.context_window,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens, message_count = excluded.message_count,
      run_count = excluded.run_count, created_at = excluded.created_at,
      updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
      stats_updated_at = excluded.stats_updated_at
  `;
}

function conversationStatsParams(record: ConversationStatsRecord): unknown[] {
  return [
    record.conversationId, record.kind, record.title, record.status, record.hermesSessionId,
    record.profileUid ?? null,
    record.profileNameSnapshot ?? record.profile ?? null,
    record.profile ?? record.profileNameSnapshot ?? null,
    record.model ?? null, record.provider ?? null, record.contextWindow ?? null,
    record.inputTokens, record.outputTokens, record.totalTokens,
    record.messageCount, record.runCount,
    record.createdAt, record.updatedAt, record.deletedAt ?? null, record.statsUpdatedAt,
  ];
}

function runUsageFactUpsertSql(): string {
  return `
    INSERT INTO run_usage_facts (
      run_id, conversation_id, profile_uid, profile_name_snapshot, profile,
      model, provider, input_tokens, output_tokens, total_tokens,
      message_count, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      profile_uid = excluded.profile_uid,
      profile_name_snapshot = excluded.profile_name_snapshot,
      profile = excluded.profile, model = excluded.model, provider = excluded.provider,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens, message_count = excluded.message_count,
      started_at = excluded.started_at, completed_at = excluded.completed_at,
      updated_at = excluded.updated_at
  `;
}

function runUsageFactParams(record: RunUsageFactRecord): unknown[] {
  return [
    record.runId, record.conversationId,
    record.profileUid ?? null,
    record.profileNameSnapshot ?? record.profile ?? null,
    record.profile ?? record.profileNameSnapshot ?? null,
    record.model ?? null, record.provider ?? null,
    record.inputTokens, record.outputTokens, record.totalTokens,
    record.messageCount, record.startedAt, record.completedAt, record.updatedAt,
  ];
}
