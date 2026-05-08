import { EventEmitter } from "events";
import crypto from "crypto";
import { type Logger } from "pino";
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
import {
  initLinkDatabase,
  upsertConversationStats,
  replaceRunUsageFactsForConversation,
  type ConversationStatsRecord,
  type RunUsageFactRecord,
} from "../storage/link-database.js";
import { openSqliteDatabase } from "../storage/sqlite.js";
import { createHermesRun, streamHermesRunEvents } from "../hermes/runs.js";

function buildConversationStats(manifest: ConversationManifest, snapshot: ConversationSnapshot): NonNullable<ConversationManifest["stats"]> {
  const agentRuns = snapshot.runs.filter(r => r.kind === "agent");
  const hasUsage = agentRuns.some(r => r.usage);
  const prev = manifest.stats;
  const inputTokens = hasUsage ? agentRuns.reduce((t, r) => t + (r.usage?.input_tokens ?? 0), 0) : prev?.input_tokens ?? 0;
  const outputTokens = hasUsage ? agentRuns.reduce((t, r) => t + (r.usage?.output_tokens ?? 0), 0) : prev?.output_tokens ?? 0;
  const totalTokens = hasUsage
    ? agentRuns.reduce((t, r) => t + (r.usage?.total_tokens ?? (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0)), 0)
    : prev?.total_tokens ?? inputTokens + outputTokens;
  const latestRun = agentRuns
    .filter(r => r.completed_at)
    .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))[0];
  const updatedAt = latestRun?.completed_at ?? prev?.updated_at ?? manifest.updated_at;
  const profileNameSnapshot = latestRun?.profile_name_snapshot ?? latestRun?.profile ?? prev?.profile_name_snapshot ?? manifest.profile;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    message_count: snapshot.messages.length || prev?.message_count || 0,
    run_count: agentRuns.length || prev?.run_count || 0,
    profile_uid: latestRun?.profile_uid ?? prev?.profile_uid ?? manifest.profile_uid ?? null,
    profile_name_snapshot: profileNameSnapshot ?? null,
    profile: profileNameSnapshot ?? null,
    model: latestRun?.model ?? prev?.model ?? null,
    provider: latestRun?.provider ?? prev?.provider ?? null,
    context_window: latestRun?.context_window ?? prev?.context_window ?? null,
    updated_at: updatedAt,
  };
}

function buildRunUsageFacts(manifest: ConversationManifest, snapshot: ConversationSnapshot): RunUsageFactRecord[] {
  return snapshot.runs
    .filter(r => r.kind === "agent" && Boolean(r.completed_at))
    .map(run => {
      const usage = run.usage;
      const profileNameSnapshot = run.profile_name_snapshot ?? run.profile ?? manifest.stats?.profile_name_snapshot ?? manifest.profile;
      const messageIds = new Set([run.trigger_message_id, run.assistant_message_id].filter(Boolean));
      const messageCount = snapshot.messages.filter(m => messageIds.has(m.id)).length;
      return {
        runId: run.id,
        conversationId: manifest.id,
        profileUid: run.profile_uid ?? manifest.stats?.profile_uid ?? manifest.profile_uid ?? null,
        profileNameSnapshot: profileNameSnapshot ?? null,
        profile: profileNameSnapshot ?? null,
        model: run.model ?? manifest.stats?.model ?? null,
        provider: run.provider ?? manifest.stats?.provider ?? null,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        messageCount,
        startedAt: run.started_at,
        completedAt: run.completed_at ?? run.started_at,
        updatedAt: run.completed_at ?? run.started_at,
      };
    });
}

function sseToRec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function sseReadText(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v ? v : null;
}

function sseReadDelta(payload: Record<string, unknown>): string | null {
  return sseReadText(payload, "delta") ?? sseReadText(payload, "text") ?? sseReadText(payload, "content");
}

function sseReadUsage(payload: Record<string, unknown>): RunUsage | null {
  const readInt = (obj: Record<string, unknown>, key: string): number | null => {
    const v = obj[key];
    return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
  };
  const usage = sseToRec(payload.usage);
  const response = sseToRec(payload.response);
  const responseUsage = sseToRec(response.usage);
  const run = sseToRec(payload.run);
  const runUsage = sseToRec(run.usage);
  const inp =
    readInt(usage, "input_tokens") ?? readInt(usage, "prompt_tokens") ??
    readInt(responseUsage, "input_tokens") ?? readInt(runUsage, "input_tokens") ?? null;
  const out =
    readInt(usage, "output_tokens") ?? readInt(usage, "completion_tokens") ??
    readInt(responseUsage, "output_tokens") ?? readInt(runUsage, "output_tokens") ?? null;
  if (inp === null && out === null) return null;
  const i = inp ?? 0, o = out ?? 0;
  const t = readInt(usage, "total_tokens") ?? readInt(responseUsage, "total_tokens") ?? readInt(runUsage, "total_tokens") ?? i + o;
  return { input_tokens: i, output_tokens: o, total_tokens: t };
}

function parseSseBlock(block: string): { payloadType: string; payload: Record<string, unknown> } | null {
  let eventName = "";
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!eventName && dataLines.length === 0) return null;
  const raw = dataLines.join("\n").trim();
  if (!raw || raw === "[DONE]") return null;
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return null; }
  const payload = sseToRec(decoded);
  const payloadType = (sseReadText(payload, "type") ?? sseReadText(payload, "event") ?? sseReadText(payload, "object") ?? eventName) || "message";
  return { payloadType, payload };
}

async function* parseSseStreamResponse(
  response: Response,
): AsyncGenerator<{ payloadType: string; payload: Record<string, unknown> }> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseBlock(block);
        if (parsed) yield parsed;
        sep = buffer.indexOf("\n\n");
      }
    }
    const trailing = parseSseBlock(buffer);
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

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
  private logger: Logger | null;
  private activeRunControllers = new Map<string, { conversationId: string; controller: AbortController }>();

  constructor(paths: RuntimePaths, logger?: Logger) {
    super();
    this.setMaxListeners(200);
    this.paths = paths;
    this.logger = logger ?? null;
  }

  async persistConversationStats(conversationId: string, snapshot?: ConversationSnapshot): Promise<void> {
    const manifest = await readManifest(this.paths, conversationId);
    if (!manifest) return;
    const snap = snapshot ?? await readSnapshot(this.paths, conversationId);
    const stats = buildConversationStats(manifest, snap);
    await writeManifest(this.paths, { ...manifest, stats });
    const statsRecord: ConversationStatsRecord = {
      conversationId: manifest.id,
      kind: manifest.kind,
      title: manifest.title,
      status: manifest.status,
      hermesSessionId: manifest.hermes_session_id ?? "",
      profileUid: stats.profile_uid ?? null,
      profileNameSnapshot: stats.profile_name_snapshot ?? null,
      profile: stats.profile ?? null,
      model: stats.model ?? null,
      provider: stats.provider ?? null,
      contextWindow: stats.context_window ?? null,
      inputTokens: stats.input_tokens,
      outputTokens: stats.output_tokens,
      totalTokens: stats.total_tokens,
      messageCount: stats.message_count,
      runCount: stats.run_count,
      createdAt: manifest.created_at,
      updatedAt: manifest.updated_at,
      deletedAt: manifest.deleted_at ?? null,
      statsUpdatedAt: stats.updated_at,
    };
    await upsertConversationStats(this.paths, statsRecord);
    const usageFacts = buildRunUsageFacts(manifest, snap);
    if (usageFacts.length > 0) {
      await replaceRunUsageFactsForConversation(this.paths, conversationId, usageFacts);
    }
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

    if (!hasActive) {
      this.startRunWorkerAndDrain(manifest.id, runId, content, input.profileName ?? manifest.profile ?? null);
    }

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
    const active = this.activeRunControllers.get(runId);
    if (active) active.controller.abort();
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
      await this.persistConversationStats(conversationId, snapshot).catch(() => undefined);
      return { conversation_id: conversationId, run: { id: run.id, status: run.status }, last_event_seq: manifest.last_event_seq };
    });
  }

  private startRunWorkerAndDrain(
    conversationId: string,
    runId: string,
    input: string,
    profileName: string | null,
  ): void {
    void this.runWorker(conversationId, runId, input, profileName).catch(async (error) => {
      this.logger?.warn({ conversation_id: conversationId, run_id: runId, err: (error as Error).message }, "run_worker_unhandled_error");
      await withConversationLock(conversationId, async () => {
        const manifest = await readManifest(this.paths, conversationId);
        if (!manifest) return;
        const snapshot = await readSnapshot(this.paths, conversationId);
        const run = snapshot.runs.find((r) => r.id === runId);
        if (!run || run.status !== "running") return;
        const now = new Date().toISOString();
        run.status = "failed";
        run.completed_at = now;
        run.error_message = (error as Error).message ?? "Worker failed";
        const asst = snapshot.messages.find((m) => m.id === run.assistant_message_id);
        if (asst) { asst.status = "failed"; asst.updated_at = now; }
        await writeSnapshot(this.paths, conversationId, snapshot);
        await this.appendAndEmit(conversationId, { type: "run.failed", run_id: runId, payload: { run, error: { message: run.error_message } } }, manifest);
        await writeManifest(this.paths, manifest);
        await this.persistConversationStats(conversationId, snapshot).catch(() => undefined);
      }).catch(() => undefined);
    });
  }

  private async runWorker(
    conversationId: string,
    runId: string,
    input: string,
    profileName: string | null,
  ): Promise<void> {
    const initialSnapshot = await readSnapshot(this.paths, conversationId);
    const run = initialSnapshot.runs.find((r) => r.id === runId);
    if (!run || run.status !== "running") return;

    const controller = new AbortController();
    this.activeRunControllers.set(runId, { conversationId, controller });

    try {
      const history = initialSnapshot.messages
        .filter((m) =>
          (m.role === "user" || m.role === "assistant") &&
          m.status === "completed" &&
          m.id !== run.trigger_message_id &&
          m.id !== run.assistant_message_id,
        )
        .map((m) => {
          const text = m.parts.find((p) => p.type === "text")?.text?.trim() ?? "";
          return text ? { role: m.role as "user" | "assistant", content: text } : null;
        })
        .filter((m): m is { role: "user" | "assistant"; content: string } => m !== null);

      const { run_id: hermesRunId } = await createHermesRun(
        {
          input,
          session_id: run.hermes_session_id ?? undefined,
          conversation_history: history,
        },
        { profileName },
      );

      const sseResponse = await streamHermesRunEvents(hermesRunId, {
        profileName,
        signal: controller.signal,
      });

      let hasOutput = false;

      for await (const { payloadType, payload } of parseSseStreamResponse(sseResponse)) {
        if (controller.signal.aborted) break;

        if (payloadType === "message.delta") {
          const delta = sseReadDelta(payload);
          if (!delta) continue;
          hasOutput = true;
          await withConversationLock(conversationId, async () => {
            const manifest = await readManifest(this.paths, conversationId);
            if (!manifest) return;
            const snap = await readSnapshot(this.paths, conversationId);
            const r = snap.runs.find((x) => x.id === runId);
            if (!r || r.status !== "running") return;
            const asst = snap.messages.find((m) => m.id === r.assistant_message_id);
            if (!asst) return;
            const textPart = asst.parts.find((p) => p.type === "text");
            if (textPart) textPart.text = (textPart.text ?? "") + delta;
            else asst.parts.push({ type: "text", text: delta });
            asst.updated_at = new Date().toISOString();
            await writeSnapshot(this.paths, conversationId, snap);
            await this.appendAndEmit(conversationId, { type: "message.updated", message_id: asst.id, run_id: runId, payload: { message: asst } }, manifest);
            await writeManifest(this.paths, manifest);
          }).catch(() => undefined);
          continue;
        }

        if (payloadType === "run.completed") {
          const usage = sseReadUsage(payload);
          await withConversationLock(conversationId, async () => {
            const manifest = await readManifest(this.paths, conversationId);
            if (!manifest) return;
            const snap = await readSnapshot(this.paths, conversationId);
            const r = snap.runs.find((x) => x.id === runId);
            if (!r || r.status !== "running") return;
            const now = new Date().toISOString();
            r.status = "completed";
            r.completed_at = now;
            if (usage) r.usage = usage;
            const asst = snap.messages.find((m) => m.id === r.assistant_message_id);
            if (asst) { asst.status = "completed"; asst.updated_at = now; }
            await writeSnapshot(this.paths, conversationId, snap);
            if (asst) await this.appendAndEmit(conversationId, { type: "message.completed", message_id: asst.id, run_id: runId, payload: { message: asst } }, manifest);
            await this.appendAndEmit(conversationId, { type: "run.completed", run_id: runId, payload: { run: r } }, manifest);
            await writeManifest(this.paths, manifest);
            await this.persistConversationStats(conversationId, snap).catch(() => undefined);
          }).catch(() => undefined);
          return;
        }

        if (payloadType === "run.failed") {
          const errMsg = sseToRec(payload.error).message;
          const errorMessage = typeof errMsg === "string" ? errMsg : "Hermes run failed";
          await withConversationLock(conversationId, async () => {
            const manifest = await readManifest(this.paths, conversationId);
            if (!manifest) return;
            const snap = await readSnapshot(this.paths, conversationId);
            const r = snap.runs.find((x) => x.id === runId);
            if (!r || r.status !== "running") return;
            const now = new Date().toISOString();
            r.status = "failed";
            r.completed_at = now;
            r.error_message = errorMessage;
            const asst = snap.messages.find((m) => m.id === r.assistant_message_id);
            if (asst) { asst.status = "failed"; asst.updated_at = now; }
            await writeSnapshot(this.paths, conversationId, snap);
            if (asst) await this.appendAndEmit(conversationId, { type: "message.failed", message_id: asst.id, run_id: runId, payload: { message: asst } }, manifest);
            await this.appendAndEmit(conversationId, { type: "run.failed", run_id: runId, payload: { run: r, error: { message: errorMessage } } }, manifest);
            await writeManifest(this.paths, manifest);
            await this.persistConversationStats(conversationId, snap).catch(() => undefined);
          }).catch(() => undefined);
          return;
        }
      }

      // Aborted mid-stream
      if (controller.signal.aborted) {
        await withConversationLock(conversationId, async () => {
          const manifest = await readManifest(this.paths, conversationId);
          if (!manifest) return;
          const snap = await readSnapshot(this.paths, conversationId);
          const r = snap.runs.find((x) => x.id === runId);
          if (!r || r.status !== "running") return;
          const now = new Date().toISOString();
          r.status = "cancelled";
          r.completed_at = now;
          const asst = snap.messages.find((m) => m.id === r.assistant_message_id);
          if (asst) { asst.status = "failed"; asst.updated_at = now; }
          await writeSnapshot(this.paths, conversationId, snap);
          await this.appendAndEmit(conversationId, { type: "run.cancelled", run_id: runId, payload: { run: r } }, manifest);
          await writeManifest(this.paths, manifest);
          await this.persistConversationStats(conversationId, snap).catch(() => undefined);
        }).catch(() => undefined);
        return;
      }

      // Stream ended without a terminal event
      await withConversationLock(conversationId, async () => {
        const manifest = await readManifest(this.paths, conversationId);
        if (!manifest) return;
        const snap = await readSnapshot(this.paths, conversationId);
        const r = snap.runs.find((x) => x.id === runId);
        if (!r || r.status !== "running") return;
        const now = new Date().toISOString();
        if (hasOutput) {
          r.status = "completed";
          r.completed_at = now;
          const asst = snap.messages.find((m) => m.id === r.assistant_message_id);
          if (asst) { asst.status = "completed"; asst.updated_at = now; }
          await writeSnapshot(this.paths, conversationId, snap);
          if (asst) await this.appendAndEmit(conversationId, { type: "message.completed", message_id: asst.id, run_id: runId, payload: { message: asst } }, manifest);
          await this.appendAndEmit(conversationId, { type: "run.completed", run_id: runId, payload: { run: r } }, manifest);
        } else {
          r.status = "failed";
          r.completed_at = now;
          r.error_message = "Stream ended without output";
          const asst = snap.messages.find((m) => m.id === r.assistant_message_id);
          if (asst) { asst.status = "failed"; asst.updated_at = now; }
          await writeSnapshot(this.paths, conversationId, snap);
          if (asst) await this.appendAndEmit(conversationId, { type: "message.failed", message_id: asst.id, run_id: runId, payload: { message: asst } }, manifest);
          await this.appendAndEmit(conversationId, { type: "run.failed", run_id: runId, payload: { run: r, error: { message: r.error_message } } }, manifest);
        }
        await writeManifest(this.paths, manifest);
        await this.persistConversationStats(conversationId, snap).catch(() => undefined);
      }).catch(() => undefined);
    } finally {
      if (this.activeRunControllers.get(runId)?.controller === controller) {
        this.activeRunControllers.delete(runId);
      }
    }
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
