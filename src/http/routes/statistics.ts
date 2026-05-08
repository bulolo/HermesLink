import Router from "@koa/router";
import type { Context } from "koa";
import type { Database } from "better-sqlite3";
import { authenticateRequest } from "../auth.js";
import { type RuntimePaths } from "../../runtime/paths.js";
import { type ConversationService } from "../../conversations/service.js";

function readNumber(row: Record<string, unknown> | undefined | null, key: string): number {
  const value = row?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function readString(row: Record<string, unknown> | undefined | null, key: string): string | undefined {
  const value = row?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function differenceInUtcDays(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDateOnly(value: string | undefined): Date | null {
  if (!value) return null;
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u.exec(value.trim());
  if (!match?.groups) return null;
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function clampDays(days: number | undefined): number {
  if (!Number.isFinite(days ?? NaN)) return 30;
  return Math.max(1, Math.min(30, Math.trunc(days ?? 30)));
}

interface UsageRange {
  fromDate: string;
  toDate: string;
  fromInclusive: string;
  toExclusive: string;
  days: number;
  dates: string[];
}

function normalizeUsageRange(filter: { days?: number; from?: string; to?: string }): UsageRange {
  const today = startOfUtcDay(new Date());
  const parsedTo = parseDateOnly(filter.to) ?? today;
  const to = parsedTo > today ? today : parsedTo;
  const requestedDays = clampDays(filter.days);
  const parsedFrom = parseDateOnly(filter.from);
  const from = parsedFrom ?? addUtcDays(to, -(requestedDays - 1));
  const normalizedFrom = differenceInUtcDays(from, to) > 29 ? addUtcDays(to, -29) : from;
  const orderedFrom = normalizedFrom > to ? to : normalizedFrom;
  const days = differenceInUtcDays(orderedFrom, to) + 1;
  return {
    fromDate: formatDateOnly(orderedFrom),
    toDate: formatDateOnly(to),
    fromInclusive: `${formatDateOnly(orderedFrom)}T00:00:00.000Z`,
    toExclusive: `${formatDateOnly(addUtcDays(to, 1))}T00:00:00.000Z`,
    days,
    dates: Array.from({ length: days }, (_v, i) => formatDateOnly(addUtcDays(orderedFrom, i))),
  };
}

function runUsageWhereClause(filter: { from?: string; to?: string; model?: string; profile?: string }): {
  sql: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.from) { conditions.push("completed_at >= ?"); params.push(filter.from); }
  if (filter.to) { conditions.push("completed_at < ?"); params.push(filter.to); }
  if (filter.model) { conditions.push("model = ?"); params.push(filter.model); }
  if (filter.profile) { conditions.push("(profile_name_snapshot = ? OR profile = ?)"); params.push(filter.profile, filter.profile); }
  return { sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

function readLinkUsageStatistics(
  db: Database,
  filter: { days?: number; from?: string; to?: string; model?: string; profile?: string },
): Record<string, unknown> {
  const range = normalizeUsageRange(filter);
  const where = runUsageWhereClause({ ...filter, from: range.fromInclusive, to: range.toExclusive });

  const totalsRow = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0)  AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0)  AS total_tokens,
      COALESCE(SUM(message_count), 0) AS message_count,
      COUNT(*)                        AS run_count,
      COUNT(DISTINCT conversation_id) AS conversation_count,
      COUNT(DISTINCT CASE WHEN model IS NOT NULL AND model <> '' THEN model END) AS model_count,
      MAX(updated_at)                 AS updated_at
    FROM run_usage_facts ${where.sql}
  `).get(...where.params) as Record<string, unknown>;

  const dailyRows = db.prepare(`
    SELECT
      substr(completed_at, 1, 10)     AS date,
      COALESCE(SUM(input_tokens), 0)  AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0)  AS total_tokens,
      COALESCE(SUM(message_count), 0) AS message_count,
      COUNT(*)                        AS run_count
    FROM run_usage_facts ${where.sql}
    GROUP BY substr(completed_at, 1, 10)
    ORDER BY date ASC
  `).all(...where.params) as Record<string, unknown>[];

  const modelRows = db.prepare(`
    SELECT
      COALESCE(NULLIF(model, ''), 'unknown') AS model,
      provider,
      COALESCE(SUM(input_tokens), 0)  AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0)  AS total_tokens,
      COALESCE(SUM(message_count), 0) AS message_count,
      COUNT(*)                        AS run_count
    FROM run_usage_facts ${where.sql}
    GROUP BY COALESCE(NULLIF(model, ''), 'unknown'), provider
    HAVING SUM(total_tokens) > 0
    ORDER BY total_tokens DESC, run_count DESC, model ASC
    LIMIT 12
  `).all(...where.params) as Record<string, unknown>[];

  const profileRows = db.prepare(`
    SELECT
      MAX(NULLIF(profile_uid, '')) AS profile_uid,
      COALESCE(
        NULLIF(profile_name_snapshot, ''),
        NULLIF(profile, ''),
        NULLIF(profile_uid, ''),
        'unknown'
      ) AS profile,
      COALESCE(SUM(input_tokens), 0)  AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0)  AS total_tokens,
      COALESCE(SUM(message_count), 0) AS message_count,
      COUNT(*)                        AS run_count
    FROM run_usage_facts ${where.sql}
    GROUP BY COALESCE(
      NULLIF(profile_name_snapshot, ''),
      NULLIF(profile, ''),
      NULLIF(profile_uid, ''),
      'unknown'
    )
    HAVING SUM(total_tokens) > 0
    ORDER BY total_tokens DESC, run_count DESC, profile ASC
    LIMIT 12
  `).all(...where.params) as Record<string, unknown>[];

  const dailyByDate = new Map(dailyRows.map((row) => [readString(row, "date") ?? "", row]));

  return {
    range: { from: range.fromDate, to: range.toDate, days: range.days },
    totals: {
      input_tokens: readNumber(totalsRow, "input_tokens"),
      output_tokens: readNumber(totalsRow, "output_tokens"),
      total_tokens: readNumber(totalsRow, "total_tokens"),
      message_count: readNumber(totalsRow, "message_count"),
      run_count: readNumber(totalsRow, "run_count"),
      conversation_count: readNumber(totalsRow, "conversation_count"),
      model_count: readNumber(totalsRow, "model_count"),
    },
    daily: range.dates.map((date) => {
      const row = dailyByDate.get(date);
      return {
        date,
        input_tokens: readNumber(row, "input_tokens"),
        output_tokens: readNumber(row, "output_tokens"),
        total_tokens: readNumber(row, "total_tokens"),
        message_count: readNumber(row, "message_count"),
        run_count: readNumber(row, "run_count"),
      };
    }),
    models: modelRows.map((row) => ({
      model: readString(row, "model") ?? "unknown",
      ...(readString(row, "provider") ? { provider: readString(row, "provider") } : {}),
      input_tokens: readNumber(row, "input_tokens"),
      output_tokens: readNumber(row, "output_tokens"),
      total_tokens: readNumber(row, "total_tokens"),
      message_count: readNumber(row, "message_count"),
      run_count: readNumber(row, "run_count"),
    })),
    profiles: profileRows.map((row) => ({
      ...(readString(row, "profile_uid") ? { profile_uid: readString(row, "profile_uid") } : {}),
      profile: readString(row, "profile") ?? "unknown",
      input_tokens: readNumber(row, "input_tokens"),
      output_tokens: readNumber(row, "output_tokens"),
      total_tokens: readNumber(row, "total_tokens"),
      message_count: readNumber(row, "message_count"),
      run_count: readNumber(row, "run_count"),
    })),
    ...(readString(totalsRow, "updated_at") ? { updated_at: readString(totalsRow, "updated_at") } : {}),
  };
}

export function createStatisticsRouter(options: {
  db: Database;
  paths: RuntimePaths;
  conversations: ConversationService;
}): Router {
  const { db, paths, conversations } = options;
  const router = new Router();

  const auth = async (ctx: Context, next: () => Promise<void>) => {
    await authenticateRequest(ctx, paths);
    await next();
  };

  router.get("/api/v1/statistics", auth, async (ctx: Context) => {
    ctx.set("cache-control", "no-store");
    const statistics = await conversations.getStatistics({
      profileName: typeof ctx.query.profile === "string" ? ctx.query.profile : undefined,
      profileUid: typeof ctx.query.profile_uid === "string" ? ctx.query.profile_uid : undefined,
    });
    ctx.body = { ok: true, statistics };
  });

  router.get("/api/v1/statistics/usage", auth, (ctx: Context) => {
    ctx.set("cache-control", "no-store");
    const days = typeof ctx.query.days === "string" ? Number.parseInt(ctx.query.days, 10) : undefined;
    const usage = readLinkUsageStatistics(db, {
      days: Number.isFinite(days) ? days : undefined,
      from: typeof ctx.query.from === "string" ? ctx.query.from : undefined,
      to: typeof ctx.query.to === "string" ? ctx.query.to : undefined,
      model: typeof ctx.query.model === "string" ? ctx.query.model : undefined,
      profile: typeof ctx.query.profile === "string" ? ctx.query.profile : undefined,
    });
    ctx.body = { ok: true, usage };
  });

  return router;
}
