import { createPublicKey, verify } from "crypto";
import type { Context } from "koa";
import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import { authenticateDeviceAccessToken, type DeviceRecord } from "../security/credentials.js";
import { loadIdentity } from "../identity/identity.js";
import { loadConfig } from "../config/config.js";
import { LinkHttpError } from "../core/errors.js";

export interface AuthResult {
  kind: "device" | "app-connect";
  device?: DeviceRecord;
  accountId?: string | null;
  scopes?: string[];
  appInstanceId?: string | null;
}

let cachedJwks: { keys: Record<string, unknown>[]; expiresAt: number } | null = null;

export async function authenticateRequest(
  ctx: Context,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<AuthResult> {
  const token = readBearerToken(ctx.get("authorization"));
  if (!token) {
    throw new LinkHttpError(401, "auth_required", "Authorization bearer token is required");
  }
  const device = await authenticateDeviceAccessToken(token, paths);
  if (device) {
    return { kind: "device", device };
  }
  if (token.startsWith("hpat_")) {
    throw new LinkHttpError(401, "device_access_token_invalid", "Device access token is invalid or expired");
  }
  const [identity, config] = await Promise.all([loadRequiredIdentity(paths), loadConfig(paths)]);
  const claims = await verifyAppConnectToken(token, { config, linkId: identity.link_id ?? null });
  return {
    kind: "app-connect",
    accountId: typeof claims.sub === "string" ? claims.sub : null,
    scopes: normalizeScopes(claims.scope),
    appInstanceId: normalizeAppInstanceId(claims.app_instance_id),
  };
}

async function loadRequiredIdentity(paths: RuntimePaths) {
  const identity = await loadIdentity(paths);
  if (!identity?.link_id) {
    throw new LinkHttpError(409, "link_not_paired", "Hermes Link is not paired");
  }
  return identity;
}

function readBearerToken(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function normalizeScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((i) => typeof i === "string").map((i) => i.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/\s+/u).map((i) => i.trim()).filter(Boolean);
  return [];
}

function normalizeAppInstanceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^appi_[A-Za-z0-9_-]{16,96}$/u.test(trimmed) ? trimmed : null;
}

async function verifyAppConnectToken(
  token: string,
  options: { config: { serverBaseUrl: string; appConnectTokenIssuer: string; appConnectTokenAudience: string }; linkId: string | null },
): Promise<Record<string, unknown>> {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new LinkHttpError(401, "app_connect_token_invalid", "App connect token is malformed");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = decodeJwtPart(encodedHeader);
  const payload = decodeJwtPart(encodedPayload);
  if (header.alg !== "ES256" || header.typ !== "JWT") {
    throw new LinkHttpError(401, "app_connect_token_invalid", "App connect token algorithm is unsupported");
  }
  if (
    payload.token_type !== "hermes_app_connect" ||
    payload.iss !== options.config.appConnectTokenIssuer ||
    payload.aud !== options.config.appConnectTokenAudience ||
    payload.link_id !== options.linkId ||
    !Number.isFinite(payload.exp as number) ||
    (payload.exp as number) <= Math.floor(Date.now() / 1000)
  ) {
    throw new LinkHttpError(401, "app_connect_token_invalid", "App connect token claims are invalid");
  }
  const jwks = await getJwks(options.config.serverBaseUrl);
  const key = (jwks.find((k) => k.kid === header.kid) ?? jwks[0]) as Record<string, unknown> | undefined;
  if (!key) {
    throw new LinkHttpError(503, "app_connect_jwks_unavailable", "App connect token key is unavailable");
  }
  const publicKey = createPublicKey({ key: key as Parameters<typeof createPublicKey>[0] & Record<string, unknown>, format: "jwk" });
  const ok = verify(
    "sha256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(base64UrlToBase64(encodedSignature as string), "base64"),
  );
  if (!ok) {
    throw new LinkHttpError(401, "app_connect_token_invalid", "App connect token signature is invalid");
  }
  return payload;
}

async function getJwks(serverBaseUrl: string): Promise<Record<string, unknown>[]> {
  if (cachedJwks && cachedJwks.expiresAt > Date.now()) return cachedJwks.keys;
  const response = await fetch(`${serverBaseUrl.replace(/\/+$/u, "")}/api/v1/app-connect/jwks.json`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new LinkHttpError(503, "app_connect_jwks_unavailable", "Unable to load app connect JWKS");
  }
  const payload = (await response.json()) as { keys?: unknown[] };
  const keys = Array.isArray(payload.keys) ? (payload.keys as Record<string, unknown>[]) : [];
  cachedJwks = { keys, expiresAt: Date.now() + 5 * 60 * 1000 };
  return keys;
}

function decodeJwtPart(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(base64UrlToBase64(value), "base64").toString("utf8")) as Record<string, unknown>;
}

function base64UrlToBase64(value: string): string {
  const n = value.replace(/-/g, "+").replace(/_/g, "/");
  return n + "=".repeat((4 - (n.length % 4)) % 4);
}

export function readAppInstanceIdHeader(ctx: Context): string | null {
  const value = ctx.get("x-hermes-app-instance-id").trim();
  return /^appi_[A-Za-z0-9_-]{16,96}$/u.test(value) ? value : null;
}

export function readDeviceModelHeader(ctx: Context): string | null {
  const value = ctx.get("x-hermes-device-model").trim();
  return value ? value.slice(0, 128) : null;
}
