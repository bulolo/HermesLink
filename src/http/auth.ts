import type { Context, Next } from "koa";
import { isDeviceTrusted, recordDeviceSeen } from "../security/devices.js";
import { consumeAppConnectToken } from "../security/app-connect-token.js";
import { type RuntimePaths } from "../runtime/paths.js";

const DEVICE_ID_HEADER = "x-hermeslink-device-id";
const TOKEN_HEADER = "x-hermeslink-connect-token";

export interface AuthContext {
  deviceId: string;
}

declare module "koa" {
  interface DefaultState {
    auth?: AuthContext;
  }
}

export function requireAuth(paths?: RuntimePaths) {
  return async (ctx: Context, next: Next): Promise<void> => {
    const deviceId = ctx.get(DEVICE_ID_HEADER);
    const connectToken = ctx.get(TOKEN_HEADER);

    // App-connect token flow (first-time pairing)
    if (connectToken) {
      const token = await consumeAppConnectToken(connectToken, paths);
      if (!token) {
        ctx.status = 401;
        ctx.body = { error: "Invalid or expired connect token" };
        return;
      }
      const trustedDeviceId = deviceId || token.token.slice(0, 16);
      ctx.state.auth = { deviceId: trustedDeviceId };
      await next();
      return;
    }

    // Existing trusted device flow
    if (!deviceId) {
      ctx.status = 401;
      ctx.body = { error: "Missing device ID" };
      return;
    }

    const trusted = await isDeviceTrusted(deviceId, paths);
    if (!trusted) {
      ctx.status = 401;
      ctx.body = { error: "Device not trusted" };
      return;
    }

    await recordDeviceSeen(deviceId, paths);
    ctx.state.auth = { deviceId };
    await next();
  };
}

export function optionalAuth(paths?: RuntimePaths) {
  return async (ctx: Context, next: Next): Promise<void> => {
    const deviceId = ctx.get(DEVICE_ID_HEADER);
    if (deviceId) {
      const trusted = await isDeviceTrusted(deviceId, paths);
      if (trusted) {
        await recordDeviceSeen(deviceId, paths);
        ctx.state.auth = { deviceId };
      }
    }
    await next();
  };
}
