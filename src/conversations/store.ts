import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { type RuntimePaths } from "../runtime/paths.js";
import { LinkHttpError } from "../core/errors.js";

export interface ConversationManifest {
  id: string;
  kind: string;
  title: string;
  status: "active" | "archived" | "deleted_soft";
  hermes_session_id: string | null;
  hermes_session_ids?: string[];
  profile_uid: string | null;
  profile_name_snapshot: string | null;
  profile: string | null;
  last_event_seq: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  stats?: ConversationStats | null;
}

export interface ConversationStats {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  message_count: number;
  run_count: number;
  profile_uid?: string | null;
  profile_name_snapshot?: string | null;
  profile?: string | null;
  model?: string | null;
  provider?: string | null;
  context_window?: number | null;
  updated_at: string;
}

export interface MessagePart {
  type: string;
  text?: string;
  blob?: string;
  mime?: string;
  size?: number;
  filename?: string;
  kind?: string;
  is_voice_note?: boolean;
  duration_ms?: number;
  waveform?: number[];
  [key: string]: unknown;
}

export type LinkApprovalDecision = "once" | "session" | "always" | "deny";
export type LinkApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface LinkApprovalRequest {
  id: string;
  status: LinkApprovalStatus;
  kind: "terminal_command";
  command: string;
  description?: string;
  pattern_key?: string;
  pattern_keys?: string[];
  choices: LinkApprovalDecision[];
  created_at: string;
  resolved_at?: string;
  decision?: LinkApprovalDecision;
  resume_available: boolean;
  resolution_hint?: string;
  resolution_hint_zh?: string;
  resolution_hint_en?: string;
  config_path?: string;
}

export interface AgentEvent {
  id: string;
  kind?: "tool" | "thinking_delta";
  title: string;
  status: "running" | "completed" | "failed" | "info";
  created_at: string;
  subtitle?: string;
  detail?: string;
  text?: string;
  phase?: "thinking" | "final";
  completed_at?: string;
  raw?: { format: string; payload: unknown };
}

export type LinkMessageBlock =
  | { id: string; type: "text"; text: string; created_at: string; updated_at?: string }
  | { id: string; type: "agent_events"; events: AgentEvent[]; created_at: string; updated_at?: string };

export interface ConversationMessage {
  id: string;
  schema_version: 1;
  conversation_id: string;
  role: "user" | "assistant" | "tool" | "system";
  status: "completed" | "streaming" | "failed" | "queued" | "cancelled";
  run_id?: string;
  client_message_id?: string;
  created_at: string;
  updated_at: string;
  sender: {
    id: string;
    type: string;
    display_name?: string;
    profile_uid?: string | null;
    profile?: string | null;
  };
  parts: MessagePart[];
  attachments: unknown[];
  blocks?: LinkMessageBlock[];
  agent_events?: AgentEvent[];
  approvals?: LinkApprovalRequest[];
  hermes?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface ConversationRun {
  id: string;
  kind: "agent";
  conversation_id: string;
  trigger_message_id: string;
  assistant_message_id: string;
  hermes_session_id: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  completed_at?: string;
  profile_uid?: string | null;
  profile_name_snapshot?: string | null;
  profile?: string | null;
  model?: string | null;
  provider?: string | null;
  context_window?: number | null;
  usage?: RunUsage;
  error_message?: string;
  error_detail?: string;
  hermes_response_id?: string;
}

export interface RunUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
}

export interface ConversationSnapshot {
  messages: ConversationMessage[];
  runs: ConversationRun[];
}

export interface ConversationEvent {
  seq: number;
  type: string;
  conversation_id: string;
  message_id?: string;
  run_id?: string;
  payload: Record<string, unknown>;
  created_at: string;
  raw?: Record<string, unknown>;
}

export function createConversationId(): string {
  return `conv_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function createMessageId(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function createRunId(): string {
  return `run_${crypto.randomUUID().replaceAll("-", "")}`;
}

function conversationDir(paths: RuntimePaths, conversationId: string): string {
  return path.join(paths.conversationsDir, conversationId);
}

function manifestPath(paths: RuntimePaths, conversationId: string): string {
  return path.join(conversationDir(paths, conversationId), "manifest.json");
}

function snapshotPath(paths: RuntimePaths, conversationId: string): string {
  return path.join(conversationDir(paths, conversationId), "snapshot.json");
}

function eventsPath(paths: RuntimePaths, conversationId: string): string {
  return path.join(conversationDir(paths, conversationId), "events.json");
}

export function blobPath(paths: RuntimePaths, blobId: string): string {
  return path.join(paths.blobsDir, blobId);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, JSON.stringify(data), { mode: 0o600 });
}

export function assertValidConversationId(id: string): void {
  if (!/^conv_[a-zA-Z0-9]+$/u.test(id)) {
    throw new LinkHttpError(400, "invalid_conversation_id", "Invalid conversation ID");
  }
}

export async function readManifest(
  paths: RuntimePaths,
  conversationId: string,
): Promise<ConversationManifest | null> {
  assertValidConversationId(conversationId);
  return readJson<ConversationManifest | null>(manifestPath(paths, conversationId), null);
}

export async function readActiveManifest(
  paths: RuntimePaths,
  conversationId: string,
): Promise<ConversationManifest> {
  const manifest = await readManifest(paths, conversationId);
  if (!manifest || manifest.status === "deleted_soft" || manifest.status === "archived") {
    throw new LinkHttpError(404, "conversation_not_found", "Conversation was not found");
  }
  return manifest;
}

export async function readExistingManifest(
  paths: RuntimePaths,
  conversationId: string,
): Promise<ConversationManifest> {
  const manifest = await readManifest(paths, conversationId);
  if (!manifest || manifest.status === "deleted_soft") {
    throw new LinkHttpError(404, "conversation_not_found", "Conversation was not found");
  }
  return manifest;
}

export async function writeManifest(
  paths: RuntimePaths,
  manifest: ConversationManifest,
): Promise<void> {
  await writeJson(manifestPath(paths, manifest.id), manifest);
}

export async function readSnapshot(
  paths: RuntimePaths,
  conversationId: string,
): Promise<ConversationSnapshot> {
  return readJson<ConversationSnapshot>(snapshotPath(paths, conversationId), { messages: [], runs: [] });
}

export async function writeSnapshot(
  paths: RuntimePaths,
  conversationId: string,
  snapshot: ConversationSnapshot,
): Promise<void> {
  await writeJson(snapshotPath(paths, conversationId), snapshot);
}

export async function readEvents(
  paths: RuntimePaths,
  conversationId: string,
): Promise<ConversationEvent[]> {
  return readJson<ConversationEvent[]>(eventsPath(paths, conversationId), []);
}

export async function appendEvent(
  paths: RuntimePaths,
  conversationId: string,
  event: Omit<ConversationEvent, "seq" | "conversation_id" | "created_at">,
  manifestRef: { last_event_seq: number },
): Promise<ConversationEvent> {
  const events = await readEvents(paths, conversationId);
  const seq = (manifestRef.last_event_seq ?? 0) + 1;
  manifestRef.last_event_seq = seq;
  const fullEvent: ConversationEvent = {
    ...event,
    seq,
    conversation_id: conversationId,
    created_at: new Date().toISOString(),
  };
  events.push(fullEvent);
  await writeJson(eventsPath(paths, conversationId), events);
  return fullEvent;
}

export async function listConversationIds(paths: RuntimePaths): Promise<string[]> {
  try {
    const { readdir } = await import("fs/promises");
    const entries = await readdir(paths.conversationsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && e.name.startsWith("conv_")).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function deleteConversationFiles(paths: RuntimePaths, conversationId: string): Promise<void> {
  await rm(conversationDir(paths, conversationId), { recursive: true, force: true }).catch(() => undefined);
}
