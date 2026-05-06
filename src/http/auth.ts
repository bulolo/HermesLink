import type { Context } from "koa";
import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import { authenticateDeviceAccessToken, type DeviceRecord } from "../security/credentials.js";
import { consumeAppConnectToken } from "../security/app-connect-token.js";
import { LinkHttpError } from "../core/errors.js";

export interface AuthResult {
  kind: "device" | "app-connect";
  device?: DeviceRecord;
  accountId?: string | null;
  scopes?: string[];
  appInstanceId?: string | null;
}

export async function authenticateRequest(
  ctx: Context,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<AuthResult> {
  const token = readBearerToken(ctx.get("authorization"));
  if (!token) {
    throw new LinkHttpError(401, "auth_required", "Authorization bearer token is required");
  }

  // Device access token (enrolled device)
  const device = await authenticateDeviceAccessToken(token, paths);
  if (device) {
    return { kind: "device", device };
  }

  if (token.startsWith("hpat_")) {
    throw new LinkHttpError(401, "device_access_token_invalid", "Device access token is invalid or expired");
  }

  // Local connect token (for local-only pairing without server)
  const localToken = await consumeAppConnectToken(token, paths);
  if (localToken) {
    return { kind: "app-connect", accountId: null, scopes: [], appInstanceId: null };
  }

  throw new LinkHttpError(401, "auth_invalid", "Token is invalid or expired");
}

function readBearerToken(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

export function readAppInstanceIdHeader(ctx: Context): string | null {
  const value = ctx.get("x-hermes-app-instance-id").trim();
  return /^appi_[A-Za-z0-9_-]{16,96}$/u.test(value) ? value : null;
}

export function readDeviceModelHeader(ctx: Context): string | null {
  const value = ctx.get("x-hermes-device-model").trim();
  return value ? value.slice(0, 128) : null;
}
