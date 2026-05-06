import { EventEmitter } from "events";
import crypto from "crypto";
import { type RuntimePaths } from "../runtime/paths.js";
import { LinkHttpError } from "../core/errors.js";
import {
  type ConversationEvent,
  type ConversationManifest,
  type ConversationMessage,
  type ConversationRun,
  type ConversationSnapshot,
  type RunUsage,
  appendEvent,
  assertValidConversationId,
  createConversationId,
  createMessageId,
  createRunId,
  listConversationIds,
  readActiveManifest,
  readEvents,
  readManifest,
  readSnapshot,
  writeManifest,
  writeSnapshot,
} from "./store.js";
import {
  writeBlob,
  readBlob,
  deleteUnreferencedBlob,
  type BlobManifest,
} from "./blobs.js";
import { initLinkDatabase } from "../storage/link-database.js";
import { openSqliteDatabase } from "../storage/sqlite.js";

const conversationLocks = new Map<string, Promise<unknown>>();

function withConversationLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const current = conversationLocks.get(id) ?? Promise.resolve();
  const next = current.then(fn, fn) as Promise<T>;
  conversationLocks.set(id, next.catch(() => undefined));
  return next;
}

function normalizeLimit(value: unknown, defaultValue: number, max: number): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : defaultValue;
  if (!Number.isFinite(n) || n < 1) return defaultValue;
  return Math.min(n, max);
}

export type ConversationServiceEvent = ConversationEvent & { conversation_id: string };

export class ConversationService extends EventEmitter {
  private paths: RuntimePaths;

  constructor(paths: RuntimePaths) {
    super();
    this.setMaxListeners(200);
    this.paths = paths;
  }

  subscribeAll(handler: (event: ConversationServiceEvent) => void): () => void {
    this.on("event", handler);
    return () => this.off("event", handler);
  }

  subscribe(conversationId: string, handler: (event: ConversationServiceEvent) => void): () => void {
    const key = `event:${conversationId}`;
    this.on(key, handler);
    return () => this.off(key, handler);
  }

  private emit2(event: ConversationEvent): void {
    const e = event as ConversationServiceEvent;
    this.emit("event", e);
    this.emit(`event:${event.conversation_id}`, e);
  }

  private async appendAndEmit(
    conversationId: string,
    event: Omit<ConversationEvent, "seq" | "conversation_id" | "created_at">,
    manifest: ConversationManifest,
  ): Promise<ConversationEvent> {
    const full = await appendEvent(this.paths, conversationId, event, manifest);
    this.emit2(full);
    return full;
  }

  async listEvents(conversationId: string, after?: number): Promise<ConversationEvent[]> {
    const events = await readEvents(this.paths, conversationId);
    if (after === undefined || after === null) return events;
    return events.filter((e) => e.seq > after);
  }

  async listConversationPage(options: { limit?: number; cursor?: string | null } = {}): Promise<{
    conversations: unknown[];
    page: { limit: number; has_more: boolean; next_cursor: string | null };
  }> {
    const limit = normalizeLimit(options.limit, 20, 100);
    const ids = await listConversationIds(this.paths);
    const manifests: ConversationManifest[] = [];
    for (const id of ids) {
      const m = await readManifest(this.paths, id);
      if (m && m.status !== "deleted_soft") manifests.push(m);
    }
    manifests.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    let startIndex = 0;
    if (options.cursor) {
      const idx = manifests.findIndex((m) => m.id === options.cursor);
      if (idx >= 0) startIndex = idx + 1;
    }
    const page = manifests.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < manifests.length;
    return {
      conversations: page.map((m) => this.summarizeManifest(m)),
      page: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore && page.length > 0 ? (page[page.length - 1]?.id ?? null) : null,
      },
    };
  }

  async searchConversationPage(options: { limit?: number; cursor?: string | null; query?: string } = {}): Promise<{
    conversations: unknown[];
    page: { limit: number; has_more: boolean; next_cursor: string | null };
  }> {
    if (!options.query?.trim()) return this.listConversationPage(options);
    const q = options.query.trim().toLowerCase();
    const limit = normalizeLimit(options.limit, 20, 100);
    const ids = await listConversationIds(this.paths);
    const results: ConversationManifest[] = [];
    for (const id of ids) {
      const m = await readManifest(this.paths, id);
      if (m && m.status !== "deleted_soft" && m.title.toLowerCase().includes(q)) {
        results.push(m);
      }
    }
    results.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const page = results.slice(0, limit);
    return {
      conversations: page.map((m) => this.summarizeManifest(m)),
      page: { limit, has_more: results.length > limit, next_cursor: null },
    };
  }

  async createConversation(options: { title?: string; profileName?: string | null } = {}): Promise<unknown> {
    const now = new Date().toISOString();
    const id = createConversationId();
    const manifest: ConversationManifest = {
      id,
      kind: "chat",
      title: options.title ?? "New conversation",
      status: "active",
      hermes_session_id: null,
      profile_uid: null,
      profile_name_snapshot: options.profileName ?? null,
      profile: options.profileName ?? null,
      last_event_seq: 0,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await writeManifest(this.paths, manifest);
    return this.summarizeManifest(manifest);
  }

  async getMessages(
    conversationId: string,
    options: { limit?: number; beforeMessageId?: string | null } = {},
  ): Promise<unknown> {
    const manifest = await readActiveManifest(this.paths, conversationId);
    const snapshot = await readSnapshot(this.paths, conversationId);
    const limit = normalizeLimit(options.limit, 50, 200);
    const total = snapshot.messages.length;
    const endIndex = options.beforeMessageId
      ? snapshot.messages.findIndex((m) => m.id === options.beforeMessageId)
      : total;
    if (endIndex < 0) throw new LinkHttpError(400, "message_cursor_not_found", "Message cursor was not found");
    const startIndex = Math.max(0, endIndex - limit);
    const messages = snapshot.messages.slice(startIndex, endIndex);
    return {
      messages,
      last_event_seq: manifest.last_event_seq,
      page: {
        limit,
        has_more_before: startIndex > 0,
        has_more_after: endIndex < total,
        oldest_message_id: messages[0]?.id ?? null,
        newest_message_id: messages[messages.length - 1]?.id ?? null,
      },
    };
  }

  async sendMessage(input: {
    conversationId: string;
    content: string;
    profileName?: string | null;
    clientMessageId?: string | null;
    idempotencyKey?: string | null;
    attachments?: unknown[];
  }): Promise<unknown> {
    return withConversationLock(input.conversationId, () => this.sendMessageLocked(input));
  }

  private async sendMessageLocked(input: {
    conversationId: string;
    content: string;
    profileName?: string | null;
    clientMessageId?: string | null;
    idempotencyKey?: string | null;
    attachments?: unknown[];
  }): Promise<unknown> {
    const content = input.content.trim();
    if (!content) throw new LinkHttpError(400, "message_content_required", "message content is required");
    const manifest = await readActiveManifest(this.paths, input.conversationId);
    const snapshot = await readSnapshot(this.paths, input.conversationId);
    const now = new Date().toISOString();
    const runId = createRunId();
    const userMessageId = createMessageId();
    const assistantMessageId = createMessageId();

    const hasActive = snapshot.runs.some((r) => r.status === "running" || r.status === "queued");

    const userMessage: ConversationMessage = {
      id: userMessageId,
      schema_version: 1,
      conversation_id: manifest.id,
      role: "user",
      status: hasActive ? "queued" : "completed",
      client_message_id: input.clientMessageId ?? undefined,
      created_at: now,
      updated_at: now,
      sender: { id: "app_user", type: "human", display_name: "Me" },
      parts: [{ type: "text", text: content }],
      attachments: [],
    };

    const assistantMessage: ConversationMessage = {
      id: assistantMessageId,
      schema_version: 1,
      conversation_id: manifest.id,
      role: "assistant",
      status: hasActive ? "queued" : "streaming",
      run_id: runId,
      created_at: now,
      updated_at: now,
      sender: { id: "agent_default", type: "agent", display_name: "Hermes", profile: manifest.profile ?? undefined },
      parts: [{ type: "text", text: "" }],
      attachments: [],
    };

    const run: ConversationRun = {
      id: runId,
      kind: "agent",
      conversation_id: manifest.id,
      trigger_message_id: userMessageId,
      assistant_message_id: assistantMessageId,
      hermes_session_id: manifest.hermes_session_id,
      status: hasActive ? "queued" : "running",
      started_at: now,
      profile_name_snapshot: manifest.profile ?? undefined,
      profile: manifest.profile ?? undefined,
    };

    snapshot.messages.push(userMessage, assistantMessage);
    snapshot.runs.push(run);
    await writeSnapshot(this.paths, manifest.id, snapshot);

    if (manifest.title === "New conversation") {
      manifest.title = content.slice(0, 60);
    }
    manifest.updated_at = now;
    await writeManifest(this.paths, manifest);

    await this.appendAndEmit(manifest.id, { type: "message.created", message_id: userMessageId, payload: { message: userMessage } }, manifest);
    await this.appendAndEmit(manifest.id, { type: "message.created", message_id: assistantMessageId, run_id: runId, payload: { message: assistantMessage } }, manifest);
    const latestEvent = await this.appendAndEmit(manifest.id, { type: "run.started", message_id: assistantMessageId, run_id: runId, payload: { run } }, manifest);
    await writeManifest(this.paths, manifest);

    return {
      conversation_id: manifest.id,
      user_message: { id: userMessageId, status: userMessage.status },
      assistant_message: { id: assistantMessageId, status: assistantMessage.status },
      run: { id: runId, status: run.status },
      last_event_seq: latestEvent.seq,
      conversation: this.summarizeManifest(manifest),
    };
  }

  async cancelRun(conversationId: string, runId: string): Promise<unknown> {
    return withConversationLock(conversationId, async () => {
      const manifest = await readActiveManifest(this.paths, conversationId);
      const snapshot = await readSnapshot(this.paths, conversationId);
      const run = snapshot.runs.find((r) => r.id === runId);
      if (!run) throw new LinkHttpError(404, "run_not_found", "Run was not found");
      if (run.status !== "running" && run.status !== "queued") {
        return { conversation_id: conversationId, run: { id: run.id, status: run.status }, last_event_seq: manifest.last_event_seq };
      }
      const now = new Date().toISOString();
      run.status = "cancelled";
      run.completed_at = now;
      const assistant = snapshot.messages.find((m) => m.id === run.assistant_message_id);
      if (assistant) {
        assistant.status = "failed";
        assistant.updated_at = now;
      }
      await writeSnapshot(this.paths, conversationId, snapshot);
      await this.appendAndEmit(conversationId, { type: "run.cancelled", run_id: runId, payload: { run } }, manifest);
      await writeManifest(this.paths, manifest);
      return { conversation_id: conversationId, run: { id: run.id, status: run.status }, last_event_seq: manifest.last_event_seq };
    });
  }

  async deleteConversation(conversationId: string): Promise<unknown> {
    assertValidConversationId(conversationId);
    return withConversationLock(conversationId, async () => {
      const manifest = await readActiveManifest(this.paths, conversationId);
      const now = new Date().toISOString();
      manifest.status = "deleted_soft";
      manifest.deleted_at = now;
      manifest.updated_at = now;
      await writeManifest(this.paths, manifest);
      return { conversation_id: conversationId, deleted_at: now };
    });
  }

  async deleteConversations(conversationIds: string[]): Promise<unknown> {
    const results: unknown[] = [];
    let failedCount = 0;
    for (const id of conversationIds) {
      try {
        const deleted = await this.deleteConversation(id);
        results.push({ ...(deleted as Record<string, unknown>), status: "deleted" });
      } catch (err) {
        failedCount++;
        results.push({
          conversation_id: id,
          status: "failed",
          error: { code: err instanceof LinkHttpError ? err.code : "internal_error", message: (err as Error).message },
        });
      }
    }
    return { deleted_count: conversationIds.length - failedCount, failed_count: failedCount, conversations: results };
  }

  async renameConversation(conversationId: string, title: string): Promise<unknown> {
    return withConversationLock(conversationId, async () => {
      const manifest = await readActiveManifest(this.paths, conversationId);
      manifest.title = title;
      manifest.updated_at = new Date().toISOString();
      await writeManifest(this.paths, manifest);
      await this.appendAndEmit(conversationId, { type: "conversation.updated", payload: { conversation: this.summarizeManifest(manifest) } }, manifest);
      await writeManifest(this.paths, manifest);
      return { conversation_id: conversationId, title };
    });
  }

  async setConversationModel(conversationId: string, modelId: string): Promise<unknown> {
    return withConversationLock(conversationId, async () => {
      const manifest = await readActiveManifest(this.paths, conversationId);
      manifest.updated_at = new Date().toISOString();
      await writeManifest(this.paths, manifest);
      return { conversation_id: conversationId, model_id: modelId };
    });
  }

  async setConversationProfile(conversationId: string, profileName: string): Promise<unknown> {
    return withConversationLock(conversationId, async () => {
      const manifest = await readActiveManifest(this.paths, conversationId);
      manifest.profile = profileName;
      manifest.profile_name_snapshot = profileName;
      manifest.updated_at = new Date().toISOString();
      await writeManifest(this.paths, manifest);
      return { conversation_id: conversationId, profile: profileName };
    });
  }

  async ackConversation(conversationId: string, lastEventSeq: number): Promise<unknown> {
    const manifest = await readActiveManifest(this.paths, conversationId);
    return { conversation_id: conversationId, last_event_seq: manifest.last_event_seq, acked_seq: lastEventSeq };
  }

  async writeBlob(conversationId: string, input: { bytes: Buffer; filename?: string; mime?: string }): Promise<BlobManifest> {
    return writeBlob(this.paths, conversationId, input);
  }

  async readBlob(conversationId: string, blobId: string): Promise<{ bytes: Buffer; mime: string; filename: string; size: number }> {
    return readBlob(this.paths, conversationId, blobId);
  }

  async deleteUnreferencedBlob(conversationId: string, blobId: string): Promise<unknown> {
    const snapshot = await readSnapshot(this.paths, conversationId);
    return deleteUnreferencedBlob(this.paths, conversationId, blobId, snapshot);
  }

  async deleteLocalConversationsForProfile(options: { profileName: string; profileUid?: string | null }): Promise<{ deleted_count: number }> {
    const ids = await listConversationIds(this.paths);
    let count = 0;
    for (const id of ids) {
      const m = await readManifest(this.paths, id);
      if (!m || m.status === "deleted_soft") continue;
      if (m.profile === options.profileName || (options.profileUid && m.profile_uid === options.profileUid)) {
        await this.deleteConversation(id);
        count++;
      }
    }
    return { deleted_count: count };
  }

  async prepareClearAllConversationPlan(): Promise<unknown> {
    const planId = `plan_${crypto.randomUUID().replaceAll("-", "")}`;
    const ids = await listConversationIds(this.paths);
    const activeIds: string[] = [];
    for (const id of ids) {
      const m = await readManifest(this.paths, id);
      if (m && m.status === "active") activeIds.push(id);
    }
    return {
      id: planId,
      status: "pending",
      conversation_count: activeIds.length,
      conversation_ids: activeIds,
      created_at: new Date().toISOString(),
    };
  }

  async readClearAllConversationPlan(planId: string): Promise<unknown> {
    return { id: planId, status: "pending", conversation_count: 0, conversation_ids: [], created_at: new Date().toISOString() };
  }

  async startClearAllConversationPlan(planId: string): Promise<unknown> {
    const ids = await listConversationIds(this.paths);
    let count = 0;
    for (const id of ids) {
      const m = await readManifest(this.paths, id);
      if (m && m.status === "active") {
        await this.deleteConversation(id).catch(() => undefined);
        count++;
      }
    }
    return { id: planId, status: "completed", deleted_count: count, completed_at: new Date().toISOString() };
  }

  async resolveApproval(input: { conversationId: string; approvalId: string; decision: string }): Promise<unknown> {
    return { conversation_id: input.conversationId, approval_id: input.approvalId, decision: input.decision };
  }

  async getStatistics(options: { profileUid?: string | null; profileName?: string | null }): Promise<{
    conversations: { total: number; active: number };
    messages: { total: number };
    runs: { total: number };
    models: { total: number };
    skills: { total: number };
    tools: { total: number };
    profiles: { total: number };
  }> {
    const ids = await listConversationIds(this.paths);
    let total = 0, active = 0, messages = 0, runs = 0;
    for (const id of ids) {
      const m = await readManifest(this.paths, id);
      if (!m) continue;
      if (options.profileName && m.profile !== options.profileName) continue;
      total++;
      if (m.status === "active") active++;
      const snap = await readSnapshot(this.paths, id);
      messages += snap.messages.length;
      runs += snap.runs.filter((r) => r.kind === "agent").length;
    }
    return {
      conversations: { total, active },
      messages: { total: messages },
      runs: { total: runs },
      models: { total: 0 },
      skills: { total: 0 },
      tools: { total: 0 },
      profiles: { total: 0 },
    };
  }

  private summarizeManifest(manifest: ConversationManifest): unknown {
    return {
      id: manifest.id,
      kind: manifest.kind,
      title: manifest.title,
      status: manifest.status,
      profile: manifest.profile,
      profile_uid: manifest.profile_uid,
      last_event_seq: manifest.last_event_seq,
      created_at: manifest.created_at,
      updated_at: manifest.updated_at,
      stats: manifest.stats ?? null,
    };
  }
}
