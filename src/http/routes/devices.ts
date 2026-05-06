import Router from "@koa/router";
import { type RuntimePaths } from "../../runtime/paths.js";
import { type Logger } from "pino";
import { authenticateRequest, readAppInstanceIdHeader, readDeviceModelHeader } from "../auth.js";
import {
  listDevices,
  readDeviceSummary,
  recordDeviceSeen,
  revokeDeviceById,
  hideRevokedDeviceFromAppList,
  renameDeviceById,
} from "../../security/credentials.js";
import { LinkHttpError } from "../../core/errors.js";

function readString(body: unknown, ...keys: string[]): string | null {
  if (!body || typeof body !== "object") return null;
  for (const key of keys) {
    const val = (body as Record<string, unknown>)[key];
    if (typeof val === "string") return val;
  }
  return null;
}

async function readJsonBody(req: import("http").IncomingMessage): Promise<unknown> {
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

export function createDevicesRouter(options: { paths: RuntimePaths; logger: Logger }): Router {
  const { paths, logger } = options;
  const router = new Router();

  router.get("/api/v1/devices", async (ctx) => {
    const auth = await authenticateRequest(ctx, paths);
    const currentDevice = auth.device
      ? await recordDeviceSeen(
          auth.device.id,
          { appInstanceId: readAppInstanceIdHeader(ctx), model: readDeviceModelHeader(ctx) },
          paths,
        ) ?? auth.device
      : null;
    const [devices, summary] = await Promise.all([listDevices(paths), readDeviceSummary(paths)]);
    const currentDeviceId = currentDevice?.id ?? null;
    ctx.set("cache-control", "no-store");
    ctx.body = {
      ok: true,
      current_device_id: currentDeviceId,
      devices: devices.map((d) => ({ ...d, current: currentDeviceId === d.id })),
      summary,
    };
  });

  router.delete("/api/v1/devices/:deviceId", async (ctx) => {
    const auth = await authenticateRequest(ctx, paths);
    const device = await revokeDeviceById(ctx.params.deviceId, paths);
    const summary = await readDeviceSummary(paths);
    ctx.body = {
      ok: true,
      current_device_revoked: auth.device?.id === device.id,
      device: { ...device, current: auth.device?.id === device.id },
      summary,
    };
    logger.info({ device_id: device.id, current_device_revoked: auth.device?.id === device.id }, "device_revoked");
  });

  router.delete("/api/v1/devices/:deviceId/app-listing", async (ctx) => {
    const auth = await authenticateRequest(ctx, paths);
    const device = await hideRevokedDeviceFromAppList(ctx.params.deviceId, paths);
    const summary = await readDeviceSummary(paths);
    ctx.body = {
      ok: true,
      device: { ...device, current: auth.device?.id === device.id },
      summary,
    };
    logger.info({ device_id: device.id }, "device_app_listing_deleted");
  });

  router.patch("/api/v1/devices/:deviceId", async (ctx) => {
    const auth = await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    const label = readString(body, "label", "device_label");
    if (!label) throw new LinkHttpError(400, "device_label_required", "Device label is required");
    const device = await renameDeviceById(ctx.params.deviceId, label, paths);
    ctx.body = {
      ok: true,
      device: { ...device, current: auth.device?.id === device.id },
    };
    logger.info({ device_id: device.id }, "device_renamed");
  });

  return router;
}
