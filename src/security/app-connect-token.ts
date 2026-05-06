import crypto from "crypto";
import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import { readJsonFile, writeJsonFile } from "../storage/atomic-json.js";
import path from "path";

const TOKENS_FILE = "app-connect-tokens.json";
const TOKEN_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export interface AppConnectToken {
  token: string;
  createdAt: string;
  usedAt: string | null;
  expiresAt: string;
}

function tokensFilePath(paths: RuntimePaths): string {
  return path.join(paths.homeDir, TOKENS_FILE);
}

async function readTokens(paths: RuntimePaths): Promise<AppConnectToken[]> {
  const raw = await readJsonFile(tokensFilePath(paths));
  if (!Array.isArray(raw)) return [];
  const now = new Date();
  return (raw as unknown[]).filter(isValidToken).filter((t) => new Date(t.expiresAt) > now);
}

function isValidToken(value: unknown): value is AppConnectToken {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<AppConnectToken>;
  return typeof t.token === "string" && typeof t.createdAt === "string" && typeof t.expiresAt === "string";
}

async function saveTokens(tokens: AppConnectToken[], paths: RuntimePaths): Promise<void> {
  await writeJsonFile(tokensFilePath(paths), tokens);
}

export async function generateAppConnectToken(paths?: RuntimePaths): Promise<AppConnectToken> {
  const runtimePaths = paths ?? resolveRuntimePaths();
  const now = new Date();
  const token: AppConnectToken = {
    token: crypto.randomBytes(32).toString("base64url"),
    createdAt: now.toISOString(),
    usedAt: null,
    expiresAt: new Date(now.getTime() + TOKEN_EXPIRY_MS).toISOString(),
  };
  const tokens = await readTokens(runtimePaths);
  tokens.push(token);
  await saveTokens(tokens, runtimePaths);
  return token;
}

export async function consumeAppConnectToken(
  tokenValue: string,
  paths?: RuntimePaths,
): Promise<AppConnectToken | null> {
  const runtimePaths = paths ?? resolveRuntimePaths();
  const tokens = await readTokens(runtimePaths);
  const index = tokens.findIndex((t) => t.token === tokenValue && !t.usedAt);
  if (index === -1) return null;
  tokens[index].usedAt = new Date().toISOString();
  await saveTokens(tokens, runtimePaths);
  return tokens[index];
}

export async function purgeExpiredTokens(paths?: RuntimePaths): Promise<void> {
  const runtimePaths = paths ?? resolveRuntimePaths();
  // readTokens already filters expired tokens
  const tokens = await readTokens(runtimePaths);
  await saveTokens(tokens, runtimePaths);
}
