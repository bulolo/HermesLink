import Router from "@koa/router";
import type { IncomingMessage } from "http";
import { type RuntimePaths } from "../../runtime/paths.js";
import { type Logger } from "pino";
import { authenticateRequest } from "../auth.js";
import { ConversationService } from "../../conversations/service.js";
import { LinkHttpError } from "../../core/errors.js";
import { beginSseStream, writeSseEvent, writeJsonSseEvent } from "../sse-stream.js";

const MAX_BLOB_UPLOAD_BYTES = 50 * 1024 * 1024;

function readString(body: unknown, ...keys: string[]): string | null {
  if (!body || typeof body !== "object") return null;
  for (const key of keys) {
    const val = (body as Record<string, unknown>)[key];
    if (typeof val === "string") return val;
  }
  return null;
}

function readStringArray(body: unknown, ...keys: string[]): string[] | null {
  if (!body || typeof body !== "object") return null;
  for (const key of keys) {
    const val = (body as Record<string, unknown>)[key];
    if (Array.isArray(val) && val.every((v) => typeof v === "string")) return val as string[];
  }
  return null;
}

function readQueryString(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  return null;
}

function readLimit(value: unknown): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : 20;
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(n, 100);
}

function readOptionalProfileName(body: unknown): string | null {
  return readString(body, "profile", "profile_name", "profileName");
}

function readHeader(ctx: import("koa").Context, name: string): string | null {
  const val = ctx.get(name);
  return val || null;
}

function resolveConversationEventCursor(options: {
  queryAfter: unknown;
  lastEventIdHeader: string | string[] | undefined;
}): number | undefined {
  const fromQuery = typeof options.queryAfter === "string" ? Number.parseInt(options.queryAfter, 10) : null;
  if (fromQuery !== null && Number.isFinite(fromQuery)) return fromQuery;
  const header = Array.isArray(options.lastEventIdHeader) ? options.lastEventIdHeader[0] : options.lastEventIdHeader;
  if (typeof header === "string") {
    const n = Number.parseInt(header, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function isConversationNotificationEvent(event: unknown): boolean {
  const type = (event as Record<string, unknown>)?.type;
  if (typeof type !== "string") return false;
  return ["conversation.updated", "message.created", "run.started", "run.completed", "run.failed", "run.cancelled"].includes(type);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { data += chunk; });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new LinkHttpError(413, "blob_too_large", "Blob is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readMessageAttachments(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value;
}

function readUploadFilenameHeader(ctx: import("koa").Context): string | null {
  const cd = ctx.get("content-disposition");
  if (!cd) return null;
  const m = /filename="([^"]+)"/u.exec(cd);
  return m ? m[1] ?? null : null;
}

export function createConversationsRouter(options: {
  paths: RuntimePaths;
  conversations: ConversationService;
  logger: Logger;
}): Router {
  const { paths, conversations } = options;
  const router = new Router();

  router.get("/api/v1/conversations", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    const result = await conversations.listConversationPage({
      limit: readLimit(ctx.query.limit),
      cursor: readQueryString(ctx.query.cursor) ?? readQueryString(ctx.query.after) ?? readQueryString(ctx.query.page_cursor),
    });
    ctx.body = { ok: true, conversations: result.conversations, page: result.page };
  });

  router.get("/api/v1/conversations/search", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    const result = await conversations.searchConversationPage({
      limit: readLimit(ctx.query.limit),
      cursor: readQueryString(ctx.query.cursor) ?? readQueryString(ctx.query.after),
      query: readQueryString(ctx.query.query) ?? readQueryString(ctx.query.q) ?? readQueryString(ctx.query.keyword) ?? "",
    });
    ctx.body = { ok: true, conversations: result.conversations, page: result.page };
  });

  router.get("/api/v1/conversations/archived", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    const result = await conversations.listArchivedConversationPage({
      limit: readLimit(ctx.query.limit),
      cursor: readQueryString(ctx.query.cursor) ?? readQueryString(ctx.query.after),
    });
    ctx.body = { ok: true, conversations: result.conversations, page: result.page };
  });

  router.get("/api/v1/conversations/archived/search", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    const result = await conversations.searchArchivedConversationPage({
      limit: readLimit(ctx.query.limit),
      cursor: readQueryString(ctx.query.cursor) ?? readQueryString(ctx.query.after),
      query: readQueryString(ctx.query.query) ?? readQueryString(ctx.query.q) ?? readQueryString(ctx.query.keyword) ?? "",
    });
    ctx.body = { ok: true, conversations: result.conversations, page: result.page };
  });

  router.post("/api/v1/conversations/archive-plans", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    const excludeIds = readStringArray(body, "exclude_conversation_ids", "excludeConversationIds") ?? [];
    const plan = await conversations.prepareArchiveAllConversationPlan({ excludeConversationIds: excludeIds });
    ctx.status = 201;
    ctx.body = { ok: true, plan };
  });

  router.get("/api/v1/conversations/archive-plans/:planId", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    ctx.body = { ok: true, plan: await conversations.readArchiveAllConversationPlan(ctx.params.planId) };
  });

  router.post("/api/v1/conversations/archive-plans/:planId/execute", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const plan = await conversations.executeArchiveAllConversationPlan(ctx.params.planId);
    ctx.body = { ok: true, plan };
  });

  router.post("/api/v1/conversations/clear-plans", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const plan = await conversations.prepareClearAllConversationPlan();
    ctx.status = 201;
    ctx.body = { ok: true, plan };
  });

  router.get("/api/v1/conversations/clear-plans/:planId", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    ctx.body = { ok: true, plan: await conversations.readClearAllConversationPlan(ctx.params.planId) };
  });

  router.post("/api/v1/conversations/clear-plans/:planId/execute", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const plan = await conversations.startClearAllConversationPlan(ctx.params.planId);
    const p = plan as Record<string, unknown>;
    ctx.status = p.status === "completed" ? 200 : 202;
    ctx.body = { ok: true, plan };
  });

  router.get("/api/v1/conversations/events", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const mode = readQueryString(ctx.query.mode);
    const notificationOnly = mode === "notifications";
    ctx.respond = false;
    const response = ctx.res;
    let unsubscribe = () => { /* noop */ };
    beginSseStream(ctx.req, response, { onClose: () => unsubscribe() });
    unsubscribe = conversations.subscribeAll((event) => {
      if (notificationOnly && !isConversationNotificationEvent(event)) return;
      writeSseEvent(response, event);
    });
  });

  router.delete("/api/v1/conversations", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    const conversationIds = readStringArray(body, "conversation_ids", "conversationIds");
    if (!conversationIds || conversationIds.length === 0) {
      throw new LinkHttpError(400, "conversation_ids_required", "conversation_ids must be a non-empty array");
    }
    const deleted = await conversations.deleteConversations(conversationIds) as Record<string, unknown>;
    const ok = deleted.failed_count === 0;
    ctx.status = ok ? 200 : 409;
    ctx.body = {
      ok,
      ...(!ok ? { error: { code: "conversation_bulk_delete_partial_failure", message: "Some conversations could not be deleted" } } : {}),
      ...deleted,
      blob_gc_completed: true,
    };
  });

  router.post("/api/v1/conversations", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    ctx.status = 201;
    ctx.body = {
      ok: true,
      conversation: await conversations.createConversation({
        title: readString(body, "title") ?? undefined,
        profileName: readOptionalProfileName(body),
      }),
    };
  });

  router.get("/api/v1/conversations/:conversationId/messages", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    const result = await conversations.getMessages(ctx.params.conversationId, {
      limit: readLimit(ctx.query.limit),
      beforeMessageId: readQueryString(ctx.query.before_message_id) ?? readQueryString(ctx.query.before),
    });
    ctx.body = { ok: true, conversation_id: ctx.params.conversationId, ...(result as Record<string, unknown>) };
  });

  router.get("/api/v1/conversations/:conversationId/events", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const after = resolveConversationEventCursor({
      queryAfter: ctx.query.after,
      lastEventIdHeader: ctx.req.headers["last-event-id"],
    });
    const history = await conversations.listEvents(ctx.params.conversationId, after);
    ctx.respond = false;
    const response = ctx.res;
    let unsubscribe = () => { /* noop */ };
    beginSseStream(ctx.req, response, { onClose: () => unsubscribe() });
    for (const event of history) writeSseEvent(response, event);
    unsubscribe = conversations.subscribe(ctx.params.conversationId, (event) => writeSseEvent(response, event));
  });

  router.post("/api/v1/conversations/:conversationId/messages", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    const content = readString(body, "content", "text", "input") ?? "";
    const attachments = readMessageAttachments((body as Record<string, unknown>)?.attachments ?? (body as Record<string, unknown>)?.blobs);
    if (!content && attachments.length === 0) {
      throw new LinkHttpError(400, "message_content_required", "message content is required");
    }
    ctx.status = 202;
    ctx.body = {
      ok: true,
      ...await conversations.sendMessage({
        conversationId: ctx.params.conversationId,
        content,
        attachments,
        clientMessageId: readString(body, "client_message_id", "clientMessageId") ?? undefined,
        idempotencyKey: readHeader(ctx, "idempotency-key") ?? undefined,
        profileName: readOptionalProfileName(body),
      }) as Record<string, unknown>,
    };
  });

  router.patch("/api/v1/conversations/:conversationId/model", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    const modelId = readString(body, "model_id", "modelId", "model");
    if (!modelId) throw new LinkHttpError(400, "model_id_required", "model_id is required");
    ctx.body = { ok: true, ...await conversations.setConversationModel(ctx.params.conversationId, modelId) as Record<string, unknown> };
  });

  router.patch("/api/v1/conversations/:conversationId/profile", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    const profileName = readOptionalProfileName(body);
    if (!profileName) throw new LinkHttpError(400, "profile_required", "profile is required");
    ctx.body = { ok: true, ...await conversations.setConversationProfile(ctx.params.conversationId, profileName) as Record<string, unknown> };
  });

  router.patch("/api/v1/conversations/:conversationId/title", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    const title = readString(body, "title", "name", "display_name");
    if (!title) throw new LinkHttpError(400, "title_required", "title is required");
    ctx.body = { ok: true, ...await conversations.renameConversation(ctx.params.conversationId, title) as Record<string, unknown> };
  });

  router.post("/api/v1/conversations/:conversationId/archive", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.body = { ok: true, ...await conversations.archiveConversation(ctx.params.conversationId) as Record<string, unknown> };
  });

  router.post("/api/v1/conversations/:conversationId/unarchive", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.body = { ok: true, ...await conversations.unarchiveConversation(ctx.params.conversationId) as Record<string, unknown> };
  });

  router.post("/api/v1/conversations/:conversationId/ack", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.body = { ok: true };
  });

  router.post("/api/v1/conversations/:conversationId/runs/:runId/cancel", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.body = { ok: true, ...await conversations.cancelRun(ctx.params.conversationId, ctx.params.runId) as Record<string, unknown> };
  });

  router.post("/api/v1/conversations/:conversationId/approvals/:approvalId/approve", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    const scope = readString(body, "scope") ?? "always";
    ctx.body = { ok: true, ...await conversations.resolveApproval({ conversationId: ctx.params.conversationId, approvalId: ctx.params.approvalId, decision: scope }) as Record<string, unknown> };
  });

  router.post("/api/v1/conversations/:conversationId/approvals/:approvalId/deny", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.body = { ok: true, ...await conversations.resolveApproval({ conversationId: ctx.params.conversationId, approvalId: ctx.params.approvalId, decision: "deny" }) as Record<string, unknown> };
  });

  router.delete("/api/v1/conversations/:conversationId", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.body = { ok: true, ...await conversations.deleteConversation(ctx.params.conversationId) as Record<string, unknown>, blob_gc_completed: true };
  });

  router.post("/api/v1/conversations/:conversationId/blobs", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const bytes = await readRawBody(ctx.req, MAX_BLOB_UPLOAD_BYTES);
    if (bytes.byteLength === 0) throw new LinkHttpError(400, "blob_empty", "Blob body is empty");
    const blob = await conversations.writeBlob(ctx.params.conversationId, {
      bytes,
      filename: readUploadFilenameHeader(ctx) ?? undefined,
      mime: ctx.get("content-type") || undefined,
    });
    ctx.status = 201;
    ctx.body = { ok: true, blob };
  });

  router.get("/api/v1/conversations/:conversationId/blobs/:blobId", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const blob = await conversations.readBlob(ctx.params.conversationId, ctx.params.blobId);
    ctx.type = blob.mime;
    ctx.set("content-disposition", `inline; filename="${blob.filename}"`);
    ctx.set("content-length", String(blob.size));
    ctx.body = blob.bytes;
  });

  router.delete("/api/v1/conversations/:conversationId/blobs/:blobId", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.body = { ok: true, ...await conversations.deleteUnreferencedBlob(ctx.params.conversationId, ctx.params.blobId) as Record<string, unknown> };
  });

  return router;
}
