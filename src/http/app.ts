import Koa from "koa";
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
import { createModelsRouter } from "./routes/models.js";
import { createProfilesRouter } from "./routes/profiles.js";
import { createCronJobsRouter } from "./routes/cron-jobs.js";
import { createRunsRouter } from "./routes/runs.js";
import { createUpdatesRouter } from "./routes/updates.js";
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
import QRCode from "qrcode";

export interface LinkServiceOptions {
  config: LinkConfig;
  identity: LinkIdentity;
  paths: RuntimePaths;
}

export interface LinkService {
  app: Koa;
  server: Server;
  stop(): Promise<void>;
}

export async function startLinkService(options: LinkServiceOptions): Promise<LinkService> {
  const { config, identity, paths } = options;
  const logger = createLogger({ paths, fileName: "link.log", level: config.logLevel });

  await initLinkDatabase(paths);
  const db = openSqliteDatabase(paths.databaseFile, { timeout: 5000 });
  await mkdir(paths.conversationsDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await mkdir(paths.blobsDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await mkdir(paths.pairingDir, { recursive: true, mode: 0o700 }).catch(() => undefined);

  const conversations = new ConversationService(paths, logger);

  const app = new Koa();
  app.use(cors({ origin: "*" }));

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

  // Pairing page with QR code
  rootRouter.get("/pair", async (ctx) => {
    const connectToken = typeof ctx.query.connect_token === "string" ? ctx.query.connect_token : "";
    const sessionId = typeof ctx.query.session_id === "string"
      ? ctx.query.session_id
      : connectToken ? `ps_${connectToken.slice(0, 16)}` : "";
    ctx.type = "text/html";
    ctx.body = await buildPairingPage({ port: config.port, connectToken, sessionId, identity });
  });

  // Main status route
  rootRouter.get("/api/v1/status", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    const [devices, profiles, linkUpdate] = await Promise.all([
      readDeviceSummary(paths),
      listHermesProfiles().catch(() => [] as string[]),
      checkForUpdates({ paths }).catch(() => null),
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
  const statsRouter = createStatisticsRouter({ db, paths, conversations });
  app.use(statsRouter.routes());
  app.use(statsRouter.allowedMethods());

  // Models routes
  const modelsRouter = createModelsRouter({ paths, logger });
  app.use(modelsRouter.routes());
  app.use(modelsRouter.allowedMethods());

  // Profiles routes
  const profilesRouter = createProfilesRouter({ paths, logger, conversations });
  app.use(profilesRouter.routes());
  app.use(profilesRouter.allowedMethods());

  // Cron jobs routes
  const cronJobsRouter = createCronJobsRouter({ paths, logger });
  app.use(cronJobsRouter.routes());
  app.use(cronJobsRouter.allowedMethods());

  // Runs routes
  const runsRouter = createRunsRouter({ paths, logger });
  app.use(runsRouter.routes());
  app.use(runsRouter.allowedMethods());

  // Updates routes
  const updatesRouter = createUpdatesRouter({ paths, logger });
  app.use(updatesRouter.routes());
  app.use(updatesRouter.allowedMethods());

  // Start HTTP server
  const listenHost = process.env.HERMESLINK_LISTEN_HOST ?? "0.0.0.0";
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.port, listenHost, () => resolve(s));
    s.once("error", reject);
  });

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    logger.info("Link service stopped");
  };

  return { app, server, stop };
}

async function buildPairingPage(options: {
  port: number;
  connectToken: string;
  sessionId: string;
  identity: LinkIdentity;
}): Promise<string> {
  const { port, connectToken, sessionId, identity } = options;

  // QR payload — App 扫码后解析这个 JSON，获取连接所需的全部信息
  const qrPayload = connectToken ? JSON.stringify({
    kind: "hermes_link_pairing",
    version: 1,
    link_id: identity.link_id ?? "",
    display_name: "Hermes Link",
    session_id: sessionId,
    code: connectToken,
    preferred_urls: [`http://127.0.0.1:${port}`],
  }) : "";

  let qrHtml = "";
  if (qrPayload) {
    try {
      const qrSvg = await QRCode.toString(qrPayload, {
        type: "svg",
        margin: 1,
        width: 240,
        errorCorrectionLevel: "M",
      });
      qrHtml = `<div class="qr">${qrSvg}</div>`;
    } catch {
      qrHtml = "";
    }
  }

  const baseUrl = `http://127.0.0.1:${port}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hermes Link — Pairing</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f0f0f; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1rem; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 2rem; max-width: 520px; width: 100%; }
    h1 { font-size: 1.2rem; font-weight: 600; margin-bottom: 0.25rem; text-align: center; }
    .subtitle { color: #6b7280; font-size: 0.85rem; text-align: center; margin-bottom: 1.5rem; }
    .qr { display: flex; justify-content: center; margin-bottom: 1.5rem; }
    .qr svg { width: 200px; height: 200px; background: #fff; border-radius: 8px; padding: 8px; }
    .section { margin-bottom: 1.25rem; }
    .label { font-size: 0.75rem; color: #6b7280; margin-bottom: 0.35rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .mono { font-family: monospace; background: #0f0f0f; border: 1px solid #2a2a2a; border-radius: 6px; padding: 0.6rem 0.75rem; font-size: 0.78rem; word-break: break-all; color: #7dd3fc; cursor: pointer; user-select: all; }
    .mono:hover { border-color: #3b82f6; }
    .divider { border: none; border-top: 1px solid #2a2a2a; margin: 1.5rem 0; }
    button { background: #3b82f6; color: #fff; border: none; border-radius: 8px; padding: 0.7rem 1.5rem; font-size: 0.9rem; cursor: pointer; width: 100%; }
    button:hover { background: #2563eb; }
    button:disabled { background: #374151; cursor: not-allowed; color: #6b7280; }
    .status { margin-top: 0.75rem; font-size: 0.85rem; padding: 0.5rem 0.75rem; border-radius: 6px; display: none; text-align: center; }
    .status.success { color: #6ee7b7; background: #064e3b22; display: block; }
    .status.error { color: #fca5a5; background: #7f1d1d22; display: block; }
    .result-row { margin-top: 0.5rem; }
    .tag { display: inline-block; font-size: 0.7rem; background: #1e3a5f; color: #93c5fd; border-radius: 4px; padding: 0.1rem 0.4rem; margin-bottom: 0.25rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Hermes Link Pairing</h1>
    <p class="subtitle">端口 ${port} · ${identity.link_id ?? "未分配"}</p>

    ${qrHtml}

    <div class="section">
      <div class="label">App 扫码内容（JSON）</div>
      <div class="mono" title="点击复制" onclick="copyText(this)">${qrPayload.replace(/</g, "&lt;")}</div>
    </div>

    <div class="section">
      <div class="label">Session ID</div>
      <div class="mono" title="点击复制" onclick="copyText(this)">${sessionId}</div>
    </div>

    <div class="section">
      <div class="label">Claim Token（code）</div>
      <div class="mono" title="点击复制" onclick="copyText(this)">${connectToken}</div>
    </div>

    <div class="section">
      <div class="label">配对接口（App 调用）</div>
      <div class="mono">POST ${baseUrl}/api/v1/pairing/claim</div>
    </div>

    <hr class="divider" />

    <div class="label" style="margin-bottom:0.75rem">浏览器快速配对</div>
    <button id="btn" onclick="pairBrowser()">在此设备上配对</button>
    <div class="status" id="status"></div>
    <div id="results"></div>
  </div>

  <script>
    ${sessionId ? `
    let pollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/v1/pairing/session?session_id=${sessionId}');
        const data = await res.json();
        if (data.ok && data.session?.claimed) {
          clearInterval(pollTimer);
          showStatus('success', 'App 已完成配对 ✓');
        }
      } catch {}
    }, 2000);
    ` : ""}

    async function pairBrowser() {
      const btn = document.getElementById('btn');
      btn.disabled = true;
      btn.textContent = '配对中...';
      try {
        const res = await fetch('/api/v1/auth/device-session', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ${connectToken}', 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_label: navigator.userAgent.slice(0, 64), device_platform: 'web' })
        });
        const data = await res.json();
        if (res.ok && data.access_token) {
          btn.textContent = '已配对';
          showStatus('success', '配对成功！');
          const results = document.getElementById('results');
          results.innerHTML = \`
            <div class="result-row"><span class="tag">access_token · 2h</span><div class="mono" onclick="copyText(this)">\${data.access_token.token}</div></div>
            <div class="result-row" style="margin-top:0.5rem"><span class="tag">refresh_token · 90days</span><div class="mono" onclick="copyText(this)">\${data.refresh_token.token}</div></div>
          \`;
        } else {
          throw new Error(data.error?.message || JSON.stringify(data));
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '在此设备上配对';
        showStatus('error', '配对失败: ' + e.message);
      }
    }

    function showStatus(type, msg) {
      const el = document.getElementById('status');
      el.className = 'status ' + type;
      el.textContent = msg;
    }

    function copyText(el) {
      navigator.clipboard.writeText(el.textContent.trim()).then(() => {
        const orig = el.style.borderColor;
        el.style.borderColor = '#10b981';
        setTimeout(() => el.style.borderColor = orig, 800);
      }).catch(() => {});
    }
  </script>
</body>
</html>`;
}
