import Koa from "koa";
import bodyParser from "koa-bodyparser";
import cors from "@koa/cors";
import Router from "@koa/router";
import { mkdir } from "fs/promises";
import type { Server } from "http";
import { type LinkConfig } from "../config/config.js";
import { type LinkIdentity } from "../identity/identity.js";
import { type RuntimePaths } from "../runtime/paths.js";
import { createLogger } from "../runtime/logger.js";
import { createSystemRouter } from "./routes/system.js";
import { createStatisticsRouter } from "./routes/statistics.js";
import { createBootstrapRouter } from "./routes/bootstrap.js";
import { createAuthRouter } from "./routes/auth.js";
import { createDevicesRouter } from "./routes/devices.js";
import { createConversationsRouter } from "./routes/conversations.js";
import { createPairingRouter } from "./routes/pairing.js";
import { RelayClient } from "../relay/relay-client.js";
import { discoverRouteCandidates } from "../network/topology.js";
import { updateNetworkReportState } from "../link/state.js";
import { openSqliteDatabase } from "../storage/sqlite.js";
import { initLinkDatabase } from "../storage/link-database.js";
import { ConversationService } from "../conversations/service.js";
import { LinkHttpError } from "../core/errors.js";
import { readRecentLogEntries, readRecentGatewayLogEntries } from "../runtime/logger.js";
import { authenticateRequest } from "./auth.js";
import { LINK_VERSION } from "../constants.js";
import { listHermesProfiles } from "../hermes/gateway.js";
import { readDeviceSummary } from "../security/credentials.js";
import { checkForUpdates } from "../link/updates.js";

export interface LinkServiceOptions {
  config: LinkConfig;
  identity: LinkIdentity;
  paths: RuntimePaths;
  relayToken: string;
}

export interface LinkService {
  app: Koa;
  server: Server;
  relayClient: RelayClient;
  stop(): Promise<void>;
}

export async function startLinkService(options: LinkServiceOptions): Promise<LinkService> {
  const { config, identity, paths, relayToken } = options;
  const logger = createLogger({ paths, fileName: "link.log", level: config.logLevel });

  await initLinkDatabase(paths);
  const db = openSqliteDatabase(paths.databaseFile, { timeout: 5000 });
  await mkdir(paths.conversationsDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await mkdir(paths.blobsDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await mkdir(paths.pairingDir, { recursive: true, mode: 0o700 }).catch(() => undefined);

  const conversations = new ConversationService(paths);

  const app = new Koa();
  app.use(cors({ origin: "*" }));
  app.use(bodyParser({ jsonLimit: "10mb" }));

  // Error handler
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      const error = err as Error & { status?: number; statusCode?: number; code?: string };
      ctx.status = error.status ?? error.statusCode ?? 500;
      ctx.body = {
        ok: false,
        error: {
          code: error.code ?? "internal_error",
          message: error.message ?? "Internal server error",
        },
      };
      if (ctx.status >= 500) {
        logger.error({ path: ctx.path, status: ctx.status, err: error.message }, "Request error");
      }
    }
  });

  const rootRouter = new Router();

  // Pairing page
  rootRouter.get("/pair", (ctx) => {
    const connectToken = typeof ctx.query.connect_token === "string" ? ctx.query.connect_token : "";
    ctx.type = "text/html";
    ctx.body = buildPairingPage({ port: config.port, connectToken });
  });

  // Main status route
  rootRouter.get("/api/v1/status", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    const [devices, profiles, linkUpdate] = await Promise.all([
      readDeviceSummary(paths),
      listHermesProfiles().catch(() => [] as string[]),
      checkForUpdates({ relayBaseUrl: config.relayBaseUrl, paths }).catch(() => null),
    ]);
    ctx.body = {
      ok: true,
      version: LINK_VERSION,
      paired: Boolean(identity.link_id),
      link_id: identity.link_id ?? null,
      port: config.port,
      link: {
        state: "online",
        version: LINK_VERSION,
        update_available: linkUpdate?.availableVersion != null,
      },
      hermes: {
        local_version: null,
        update_available: false,
      },
      gateway: { state: "unknown", issue: null },
      api_server: { state: "unknown", issue: null },
      devices,
      profiles: { total: profiles.length },
    };
  });

  // Logs route
  rootRouter.get("/api/v1/logs", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const source = typeof ctx.query.source === "string" ? ctx.query.source : "link";
    const limit = typeof ctx.query.limit === "string" ? Number.parseInt(ctx.query.limit, 10) : 50;
    ctx.set("cache-control", "no-store");
    ctx.body = {
      ok: true,
      source,
      logs: source === "gateway"
        ? await readRecentGatewayLogEntries({ paths, limit })
        : await readRecentLogEntries({ paths, limit }),
    };
  });

  app.use(rootRouter.routes());
  app.use(rootRouter.allowedMethods());

  // Bootstrap (no auth required)
  const bootstrapRouter = createBootstrapRouter({ paths });
  app.use(bootstrapRouter.routes());
  app.use(bootstrapRouter.allowedMethods());

  // Auth routes
  const authRouter = createAuthRouter({ paths, logger });
  app.use(authRouter.routes());
  app.use(authRouter.allowedMethods());

  // Pairing routes
  const pairingRouter = createPairingRouter({ paths, logger });
  app.use(pairingRouter.routes());
  app.use(pairingRouter.allowedMethods());

  // Devices routes
  const devicesRouter = createDevicesRouter({ paths, logger });
  app.use(devicesRouter.routes());
  app.use(devicesRouter.allowedMethods());

  // Conversations routes
  const conversationsRouter = createConversationsRouter({ paths, conversations, logger });
  app.use(conversationsRouter.routes());
  app.use(conversationsRouter.allowedMethods());

  // System routes
  const systemRouter = createSystemRouter({ config, identity, paths });
  app.use(systemRouter.routes());
  app.use(systemRouter.allowedMethods());

  // Statistics routes
  const statsRouter = createStatisticsRouter({ db, paths });
  app.use(statsRouter.routes());
  app.use(statsRouter.allowedMethods());

  // Start HTTP server
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });

  // Relay client
  const relayClient = new RelayClient({
    relayBaseUrl: config.relayBaseUrl,
    identity,
    token: relayToken,
    paths,
  });
  relayClient.start();

  // Initial network report
  reportNetwork({ config, identity, paths }).catch(() => undefined);

  const stop = async (): Promise<void> => {
    relayClient.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    logger.info("Link service stopped");
  };

  return { app, server, relayClient, stop };
}

async function reportNetwork(options: {
  config: LinkConfig;
  identity: LinkIdentity;
  paths: RuntimePaths;
}): Promise<void> {
  const candidates = await discoverRouteCandidates({
    configuredLanHost: options.config.lanHost,
    relayBaseUrl: options.config.relayBaseUrl,
    linkId: options.identity.link_id ?? "",
    port: options.config.port,
    installId: options.identity.install_id,
    publicKeyPem: options.identity.public_key_pem,
  });
  await updateNetworkReportState(
    {
      lastReportedAt: new Date().toISOString(),
      preferredUrls: candidates.preferredUrls,
      lanIps: candidates.lanIps,
      publicIpv4s: candidates.publicIpv4s,
      publicIpv6s: candidates.publicIpv6s,
    },
    options.paths,
  );
}

function buildPairingPage(options: { port: number; connectToken: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hermes Link — Pairing</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f0f0f; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 2rem; max-width: 420px; width: 100%; text-align: center; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { color: #a0a0a0; font-size: 0.9rem; margin-bottom: 1.5rem; line-height: 1.5; }
    .token { font-family: monospace; background: #0f0f0f; border: 1px solid #333; border-radius: 6px; padding: 0.75rem 1rem; font-size: 0.85rem; word-break: break-all; color: #7dd3fc; margin-bottom: 1.5rem; }
    button { background: #3b82f6; color: #fff; border: none; border-radius: 8px; padding: 0.75rem 1.5rem; font-size: 0.95rem; cursor: pointer; width: 100%; }
    button:hover { background: #2563eb; }
    .status { margin-top: 1rem; font-size: 0.85rem; color: #6ee7b7; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Hermes Link Pairing</h1>
    <p>Use this page to pair your device with the local Hermes Link service running on port ${options.port}.</p>
    <div class="token" id="token">${options.connectToken}</div>
    <button onclick="pair()">Pair This Device</button>
    <div class="status" id="status">Paired successfully!</div>
  </div>
  <script>
    async function pair() {
      const token = document.getElementById('token').textContent;
      try {
        const res = await fetch('http://127.0.0.1:${options.port}/api/v1/bootstrap');
        if (res.ok) {
          document.getElementById('status').style.display = 'block';
        }
      } catch (e) {
        alert('Connection failed: ' + e.message);
      }
    }
  </script>
</body>
</html>`;
}
