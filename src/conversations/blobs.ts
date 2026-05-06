import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { type RuntimePaths } from "../runtime/paths.js";
import { LinkHttpError } from "../core/errors.js";
import { type ConversationSnapshot, assertValidConversationId, blobPath } from "./store.js";
import { readJsonFile, writeJsonFile } from "../storage/atomic-json.js";

const MAX_BLOB_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB

export interface BlobManifest {
  id: string;
  size: number;
  mime: string;
  filename: string;
  created_at: string;
  conversation_ids: string[];
}

function blobManifestPath(paths: RuntimePaths, blobId: string): string {
  return `${blobPath(paths, blobId)}.json`;
}

function normalizeMime(mime: string | undefined, filename: string | undefined): string {
  if (mime && mime !== "application/octet-stream") return mime;
  if (filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
      ".gif": "image/gif", ".webp": "image/webp", ".mp3": "audio/mpeg",
      ".mp4": "video/mp4", ".wav": "audio/wav", ".pdf": "application/pdf",
      ".txt": "text/plain", ".json": "application/json",
    };
    if (mimeMap[ext]) return mimeMap[ext];
  }
  return "application/octet-stream";
}

function sanitizeFilename(filename: string | undefined, fallback: string): string {
  if (!filename) return fallback;
  return path.basename(filename).replace(/[^\w.\-]/gu, "_").slice(0, 255) || fallback;
}

export async function writeBlob(
  paths: RuntimePaths,
  conversationId: string,
  input: { bytes: Buffer; filename?: string; mime?: string },
): Promise<BlobManifest> {
  assertValidConversationId(conversationId);
  if (input.bytes.byteLength === 0) {
    throw new LinkHttpError(400, "blob_empty", "Blob body is empty");
  }
  if (input.bytes.byteLength > MAX_BLOB_UPLOAD_BYTES) {
    throw new LinkHttpError(413, "blob_too_large", "Blob is too large");
  }
  const id = `blob_${crypto.randomUUID().replaceAll("-", "")}`;
  const filePath = blobPath(paths, id);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, input.bytes, { mode: 0o600 });
  const blob: BlobManifest = {
    id,
    size: input.bytes.byteLength,
    mime: normalizeMime(input.mime, input.filename),
    filename: sanitizeFilename(input.filename, id),
    created_at: new Date().toISOString(),
    conversation_ids: [conversationId],
  };
  await writeJsonFile(blobManifestPath(paths, id), blob);
  return blob;
}

export async function readBlob(
  paths: RuntimePaths,
  conversationId: string,
  blobId: string,
): Promise<{ bytes: Buffer; mime: string; filename: string; size: number }> {
  assertValidConversationId(conversationId);
  const manifest = await readBlobManifest(paths, conversationId, blobId);
  const filePath = blobPath(paths, blobId);
  const bytes = await readFile(filePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new LinkHttpError(404, "blob_not_found", "Blob was not found");
    throw err;
  });
  return {
    bytes,
    mime: manifest.mime || "application/octet-stream",
    filename: manifest.filename || blobId,
    size: manifest.size || bytes.byteLength,
  };
}

async function readBlobManifest(
  paths: RuntimePaths,
  conversationId: string,
  blobId: string,
): Promise<BlobManifest> {
  const raw = await readJsonFile(blobManifestPath(paths, blobId));
  if (!raw || typeof raw !== "object") {
    throw new LinkHttpError(404, "blob_not_found", "Blob was not found");
  }
  const manifest = raw as Partial<BlobManifest>;
  if (!manifest.conversation_ids?.includes(conversationId)) {
    throw new LinkHttpError(404, "blob_not_found", "Blob was not found");
  }
  return raw as BlobManifest;
}

export function isBlobReferenced(snapshot: ConversationSnapshot, blobId: string): boolean {
  return snapshot.messages.some((m) =>
    m.parts.some((p) => p.blob === blobId) ||
    m.attachments.some((a) => (a as Record<string, unknown>).blob_id === blobId),
  );
}

export async function deleteUnreferencedBlob(
  paths: RuntimePaths,
  conversationId: string,
  blobId: string,
  snapshot: ConversationSnapshot,
): Promise<{ deleted: boolean; blob_id: string }> {
  assertValidConversationId(conversationId);
  if (isBlobReferenced(snapshot, blobId)) {
    throw new LinkHttpError(409, "blob_in_use", "Blob is already referenced by a conversation message");
  }
  const manifestPath = blobManifestPath(paths, blobId);
  const raw = await readJsonFile(manifestPath);
  const manifest = raw as Partial<BlobManifest> | null;
  const nextIds = (manifest?.conversation_ids ?? []).filter((id) => id !== conversationId);
  if (nextIds.length > 0) {
    await writeJsonFile(manifestPath, { ...manifest, conversation_ids: nextIds });
  } else {
    await rm(blobPath(paths, blobId), { force: true }).catch(() => undefined);
    await rm(manifestPath, { force: true }).catch(() => undefined);
  }
  return { deleted: true, blob_id: blobId };
}

export function collectBlobIds(snapshot: ConversationSnapshot): string[] {
  const ids = new Set<string>();
  for (const msg of snapshot.messages) {
    for (const part of msg.parts) {
      if (part.blob) ids.add(part.blob);
    }
    for (const att of msg.attachments) {
      const a = att as Record<string, unknown>;
      if (typeof a.blob_id === "string") ids.add(a.blob_id);
    }
  }
  return [...ids];
}
