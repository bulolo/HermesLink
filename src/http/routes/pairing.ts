import Router from "@koa/router";
import path from "path";
import { type RuntimePaths } from "../../runtime/paths.js";
import { type Logger } from "pino";
import { readJsonFile, writeJsonFile } from "../../storage/atomic-json.js";
import { loadIdentity } from "../../identity/identity.js";
import { createDeviceSession } from "../../security/credentials.js";
import { LinkHttpError } from "../../core/errors.js";

function readString(body: unknown, ...keys: string[]): string | null {
  if (!body || typeof body !== "object") return null;
  for (const key of keys) {
    const val = (body as Record<string, unknown>)[key];
    if (typeof val === "string") return val;
  }
  return null;
}

function readQueryString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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

interface PairingSession {
  session_id: string;
  code: string;
  link_id: string;
  display_name: string;
  local_api_url: string;
  preferred_urls: string[];
  created_at: string;
  expires_at: string;
}

function pairingSessionPath(sessionId: string, paths: RuntimePaths): string {
  return path.join(paths.pairingDir, `${Buffer.from(sessionId).toString("base64url")}.json`);
}

function pairingClaimPath(sessionId: string, paths: RuntimePaths): string {
  return path.join(paths.pairingDir, `${Buffer.from(sessionId).toString("base64url")}.claimed.json`);
}

async function readPairingSession(sessionId: string, paths: RuntimePaths): Promise<PairingSession | null> {
  const record = await readJsonFile(pairingSessionPath(sessionId, paths));
  if (
    !record ||
    (record as Record<string, unknown>).session_id !== sessionId ||
    typeof (record as Record<string, unknown>).code !== "string" ||
    typeof (record as Record<string, unknown>).link_id !== "string"
  ) {
    return null;
  }
  const r = record as Record<string, unknown>;
  return {
    session_id: r.session_id as string,
    code: r.code as string,
    link_id: r.link_id as string,
    display_name: (r.display_name as string) ?? "Hermes Link",
    local_api_url: (r.local_api_url as string) ?? "",
    preferred_urls: Array.isArray(r.preferred_urls) ? (r.preferred_urls as string[]).filter((v) => typeof v === "string") : [],
    created_at: r.created_at as string,
    expires_at: r.expires_at as string,
  };
}

async function isPairingSessionClaimed(sessionId: string, paths: RuntimePaths): Promise<boolean> {
  const claimRecord = await readJsonFile(pairingClaimPath(sessionId, paths));
  return claimRecord !== null;
}

function isPairingSessionExpired(session: PairingSession): boolean {
  const ms = Date.parse(session.expires_at);
  return !Number.isFinite(ms) || Date.now() >= ms;
}

async function recordPairingClaim(
  input: { sessionId: string; deviceId: string; deviceLabel: string; devicePlatform: string },
  paths: RuntimePaths,
): Promise<void> {
  const record = {
    session_id: input.sessionId,
    device_id: input.deviceId,
    device_label: input.deviceLabel,
    device_platform: input.devicePlatform,
    claimed_at: new Date().toISOString(),
  };
  await writeJsonFile(pairingClaimPath(input.sessionId, paths), record);
}

export function createPairingRouter(options: {
  paths: RuntimePaths;
  logger: Logger;
  onPairingClaimed?: () => void;
}): Router {
  const { paths, logger, onPairingClaimed } = options;
  const router = new Router();

  // GET /api/v1/pairing/session — check pairing session state (used by pairing page polling)
  router.get("/api/v1/pairing/session", async (ctx) => {
    const sessionId = readQueryString(ctx.query.session_id) ?? readQueryString(ctx.query.sessionId);
    if (!sessionId) {
      throw new LinkHttpError(400, "pairing_session_required", "session_id is required");
    }
    const session = await readPairingSession(sessionId, paths);
    if (!session) {
      throw new LinkHttpError(404, "pairing_session_not_found", "Pairing session was not found");
    }
    const claimed = await isPairingSessionClaimed(sessionId, paths);
    if (!claimed && isPairingSessionExpired(session)) {
      throw new LinkHttpError(404, "pairing_session_expired", "Pairing session has expired");
    }
    ctx.set("cache-control", "no-store");
    ctx.body = {
      ok: true,
      session: {
        session_id: session.session_id,
        link_id: session.link_id,
        display_name: session.display_name,
        local_api_url: session.local_api_url,
        preferred_urls: session.preferred_urls,
        created_at: session.created_at,
        expires_at: session.expires_at,
        claimed,
      },
    };
  });

  // POST /api/v1/pairing/claim — claim a pairing session with token
  router.post("/api/v1/pairing/claim", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const sessionId = readString(body, "session_id", "sessionId");
    const claimToken = readString(body, "claim_token", "claimToken");
    if (!sessionId || !claimToken) {
      throw new LinkHttpError(400, "pairing_claim_invalid", "session_id and claim_token are required");
    }
    const [identity, localSession] = await Promise.all([
      loadIdentity(paths),
      readPairingSession(sessionId, paths),
    ]);
    if (!identity?.link_id) throw new LinkHttpError(409, "link_not_paired", "Hermes Link is not paired");
    if (!localSession) throw new LinkHttpError(404, "pairing_session_not_found", "Pairing session was not found");
    if (isPairingSessionExpired(localSession)) throw new LinkHttpError(404, "pairing_session_expired", "Pairing session has expired");
    if (localSession.link_id !== identity.link_id) throw new LinkHttpError(409, "pairing_claim_mismatch", "Pairing claim does not match this Link");
    if (localSession.code !== claimToken) {
      throw new LinkHttpError(409, "pairing_claim_mismatch", "Pairing claim token does not match");
    }

    const appInstanceId = readString(body, "app_instance_id", "appInstanceId");
    const deviceLabel = readString(body, "device_label", "deviceLabel") ?? "HermesPilot App";
    const devicePlatform = readString(body, "device_platform", "devicePlatform") ?? "unknown";
    const session = await createDeviceSession(
      { label: deviceLabel, platform: devicePlatform, model: readString(body, "device_model", "deviceModel"), appInstanceId },
      paths,
    );

    ctx.body = {
      ok: true,
      link: { link_id: identity.link_id, display_name: "Hermes Link" },
      device: session.device,
      access_token: { token: session.accessToken.token, expires_at: session.accessToken.expiresAt },
      refresh_token: { token: session.refreshToken.token, expires_at: session.refreshToken.expiresAt },
    };

    logger.info({ device_id: session.device.device_id, device_platform: session.device.platform }, "pairing_claimed");

    const timer = setTimeout(() => {
      void recordPairingClaim(
        { sessionId, deviceId: session.device.device_id, deviceLabel, devicePlatform },
        paths,
      ).catch(() => undefined);
      onPairingClaimed?.();
    }, 250);
    timer.unref?.();
  });

  return router;
}
