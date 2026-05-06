import Router from "@koa/router";
import type { Context } from "koa";
import type { Database } from "better-sqlite3";
import { requireAuth } from "../auth.js";
import { type RuntimePaths } from "../../runtime/paths.js";

interface ConversationStatRow {
  date: string;
  profile_name: string;
  conversation_count: number;
  message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

interface RunUsageRow {
  date: string;
  profile_name: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  run_count: number;
}

export function createStatisticsRouter(options: {
  db: Database;
  paths: RuntimePaths;
}): Router {
  const router = new Router({ prefix: "/api/v1/statistics" });
  const auth = requireAuth(options.paths);

  router.get("/conversations", auth, (ctx: Context) => {
    const { from, to, profile } = ctx.query;
    let query = `SELECT date, profile_name, conversation_count, message_count,
      total_input_tokens, total_output_tokens
      FROM conversation_stats WHERE 1=1`;
    const params: string[] = [];
    if (typeof from === "string") {
      query += " AND date >= ?";
      params.push(from);
    }
    if (typeof to === "string") {
      query += " AND date <= ?";
      params.push(to);
    }
    if (typeof profile === "string" && profile) {
      query += " AND profile_name = ?";
      params.push(profile);
    }
    query += " ORDER BY date DESC, profile_name ASC LIMIT 500";
    const rows = options.db.prepare(query).all(...params) as ConversationStatRow[];
    ctx.body = { rows };
  });

  router.get("/usage", auth, (ctx: Context) => {
    const { from, to, profile, model } = ctx.query;
    let query = `SELECT date, profile_name, model,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, run_count
      FROM run_usage_facts WHERE 1=1`;
    const params: string[] = [];
    if (typeof from === "string") {
      query += " AND date >= ?";
      params.push(from);
    }
    if (typeof to === "string") {
      query += " AND date <= ?";
      params.push(to);
    }
    if (typeof profile === "string" && profile) {
      query += " AND profile_name = ?";
      params.push(profile);
    }
    if (typeof model === "string" && model) {
      query += " AND model = ?";
      params.push(model);
    }
    query += " ORDER BY date DESC, profile_name ASC, model ASC LIMIT 1000";
    const rows = options.db.prepare(query).all(...params) as RunUsageRow[];
    ctx.body = { rows };
  });

  router.post("/conversations/upsert", auth, (ctx: Context) => {
    const body = ctx.request.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      ctx.status = 400;
      ctx.body = { error: "Invalid body" };
      return;
    }
    const { date, profileName, conversationCount, messageCount, totalInputTokens, totalOutputTokens } = body;
    if (!date || !profileName) {
      ctx.status = 400;
      ctx.body = { error: "Missing required fields: date, profileName" };
      return;
    }
    options.db
      .prepare(
        `INSERT INTO conversation_stats
          (date, profile_name, conversation_count, message_count, total_input_tokens, total_output_tokens)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (date, profile_name) DO UPDATE SET
            conversation_count = excluded.conversation_count,
            message_count = excluded.message_count,
            total_input_tokens = excluded.total_input_tokens,
            total_output_tokens = excluded.total_output_tokens`,
      )
      .run(
        date,
        profileName,
        Number(conversationCount) || 0,
        Number(messageCount) || 0,
        Number(totalInputTokens) || 0,
        Number(totalOutputTokens) || 0,
      );
    ctx.body = { ok: true };
  });

  router.post("/usage/upsert", auth, (ctx: Context) => {
    const body = ctx.request.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      ctx.status = 400;
      ctx.body = { error: "Invalid body" };
      return;
    }
    const { date, profileName, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, runCount } =
      body;
    if (!date || !profileName || !model) {
      ctx.status = 400;
      ctx.body = { error: "Missing required fields: date, profileName, model" };
      return;
    }
    options.db
      .prepare(
        `INSERT INTO run_usage_facts
          (date, profile_name, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, run_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (date, profile_name, model) DO UPDATE SET
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cache_creation_tokens = excluded.cache_creation_tokens,
            cache_read_tokens = excluded.cache_read_tokens,
            run_count = excluded.run_count`,
      )
      .run(
        date,
        profileName,
        model,
        Number(inputTokens) || 0,
        Number(outputTokens) || 0,
        Number(cacheCreationTokens) || 0,
        Number(cacheReadTokens) || 0,
        Number(runCount) || 0,
      );
    ctx.body = { ok: true };
  });

  return router;
}
