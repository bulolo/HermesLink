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
import { createPairingRouter, readPairingSession, isPairingSessionClaimed, isPairingSessionExpired } from "./routes/pairing.js";
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
    const sessionId = typeof ctx.query.session_id === "string" ? ctx.query.session_id : "";
    if (!sessionId) {
      ctx.status = 400;
      ctx.type = "text/plain";
      ctx.body = "Missing session_id";
      return;
    }
    const session = await readPairingSession(sessionId, paths);
    if (!session) {
      ctx.status = 404;
      ctx.type = "text/plain";
      ctx.body = "Pairing session not found";
      return;
    }
    const claimed = await isPairingSessionClaimed(sessionId, paths);
    ctx.set("content-type", "text/html; charset=utf-8");
    ctx.set("cache-control", "no-store");
    ctx.body = await renderPairingPage({
      session,
      claimed,
      version: LINK_VERSION,
      linkId: identity.link_id ?? session.link_id,
    });
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

interface PairingSessionForPage {
  session_id: string;
  code: string;
  link_id: string;
  display_name: string;
  local_api_url: string;
  preferred_urls: string[];
  expires_at: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

async function renderPairingPage(options: {
  session: PairingSessionForPage;
  claimed: boolean;
  version: string;
  linkId: string;
}): Promise<string> {
  const { session, claimed, version, linkId } = options;
  const isExpired = !claimed && isPairingSessionExpired(session as Parameters<typeof isPairingSessionExpired>[0]);
  const qrPayload = JSON.stringify({
    kind: "hermes_link_pairing",
    version: 1,
    link_id: session.link_id,
    display_name: session.display_name,
    session_id: session.session_id,
    code: session.code,
    preferred_urls: session.preferred_urls,
  });
  const qrSvg = await QRCode.toString(qrPayload, { type: "svg", margin: 1, width: 320, errorCorrectionLevel: "M" });
  const qrDataUri = `data:image/svg+xml;base64,${Buffer.from(qrSvg).toString("base64")}`;
  const currentUrl = session.local_api_url.replace(/\/+$/u, "");
  const expiresAtMs = Date.parse(session.expires_at);
  const initialState = claimed ? "claimed" : isExpired ? "expired" : "waiting";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Hermes Link Pairing</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f4f5f7;
      --panel: rgba(255,255,255,0.78);
      --panel-strong: rgba(255,255,255,0.94);
      --text: #151922;
      --muted: #5f6673;
      --line: rgba(21,25,34,0.12);
      --accent: #2d5cff;
      --accent-soft: rgba(45,92,255,0.12);
      --good: #0b8457;
      --shadow: 0 24px 90px rgba(18,24,38,0.12);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0c1017;
        --panel: rgba(16,20,28,0.78);
        --panel-strong: rgba(16,20,28,0.94);
        --text: #eef2f8;
        --muted: #9ba4b3;
        --line: rgba(255,255,255,0.12);
        --accent: #8ab4ff;
        --accent-soft: rgba(138,180,255,0.12);
        --good: #67d7a7;
        --shadow: 0 24px 90px rgba(0,0,0,0.45);
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: linear-gradient(180deg, var(--bg) 0%, color-mix(in srgb, var(--bg) 88%, var(--accent) 12%) 100%); }
    .shell { min-height: 100vh; display: grid; place-items: center; padding: 28px 18px; }
    .panel { width: min(1040px, 100%); border: 1px solid var(--line); border-radius: 28px; background: var(--panel); box-shadow: var(--shadow); backdrop-filter: blur(18px); overflow: hidden; }
    .hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, 390px); gap: 0; }
    .copy { padding: 34px 34px 30px; border-right: 1px solid var(--line); }
    .header-row { display: flex; justify-content: space-between; align-items: center; }
    .eyebrow { display: inline-flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 13px; font-weight: 600; }
    .lang-btn { background: var(--accent-soft); color: var(--accent); border: none; border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; line-height: 1; }
    .lang-btn:hover { opacity: 0.75; }
    h1 { margin: 18px 0 12px; font-size: clamp(34px, 4vw, 52px); line-height: 1.02; }
    .subtitle { max-width: 42ch; margin: 0; color: var(--muted); font-size: 16px; line-height: 1.7; }
    .meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 26px; }
    .meta { padding: 16px 16px 15px; border-radius: 18px; background: var(--panel-strong); border: 1px solid var(--line); }
    .meta-label { display: block; color: var(--muted); font-size: 12px; line-height: 1.4; margin-bottom: 8px; }
    .meta-value { font-size: 15px; line-height: 1.5; word-break: break-word; }
    .steps { display: grid; gap: 10px; margin-top: 18px; }
    .step { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; border: 1px solid var(--line); border-radius: 18px; background: var(--panel-strong); }
    .step-badge { flex: none; width: 26px; height: 26px; border-radius: 999px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); font-size: 13px; font-weight: 600; }
    .step-title { font-size: 14px; line-height: 1.45; margin: 0; font-weight: 600; }
    .step-copy { margin: 3px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .hint { margin: 10px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .qr { padding: 26px 26px 30px; background: linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0)); }
    .card { border: 1px solid var(--line); border-radius: 24px; background: var(--panel-strong); padding: 20px; }
    .status { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; }
    .status-title { margin: 0; font-size: 18px; line-height: 1.3; }
    .pill { display: inline-flex; align-items: center; justify-content: center; padding: 7px 11px; border-radius: 999px; background: rgba(11,132,87,0.12); color: var(--good); font-size: 12px; font-weight: 600; white-space: nowrap; }
    .qr-frame { display: grid; place-items: center; padding: 18px; border-radius: 24px; background: linear-gradient(180deg, rgba(45,92,255,0.06), rgba(45,92,255,0)); border: 1px solid var(--line); }
    .qr-frame img { width: min(100%, 300px); aspect-ratio: 1; display: block; border-radius: 18px; background: #fff; padding: 14px; }
    .manual { margin-top: 16px; border: 1px solid var(--line); border-radius: 18px; overflow: hidden; }
    .manual-row { display: flex; flex-direction: column; gap: 2px; padding: 12px 16px; background: rgba(0,0,0,0.03); }
    .manual-row + .manual-row { border-top: 1px solid var(--line); }
    .manual-label { font-size: 11px; color: var(--muted); letter-spacing: 0.04em; }
    .manual-value { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 14px; word-break: break-all; user-select: all; }
    .manual-value.code { font-size: 20px; letter-spacing: 0.16em; text-align: center; }
    .footer { display: flex; justify-content: space-between; gap: 18px; flex-wrap: wrap; padding-top: 16px; color: var(--muted); font-size: 13px; line-height: 1.55; }
    @media (max-width: 920px) { .hero { grid-template-columns: 1fr; } .copy { border-right: none; border-bottom: 1px solid var(--line); } }
    @media (max-width: 640px) { .copy, .qr { padding: 22px 18px; } .meta-grid { grid-template-columns: 1fr; } .status { align-items: flex-start; flex-direction: column; } .code { font-size: 18px; letter-spacing: 0.14em; } }
  </style>
</head>
<body>
  <main class="shell">
    <section class="panel">
      <div class="hero">
        <div class="copy">
          <div class="header-row">
            <span class="eyebrow">Hermes Link · ${escapeHtml(version)}</span>
            <button id="langToggle" class="lang-btn">EN</button>
          </div>
          <h1 data-i18n="h1">在 App 里完成这次配对</h1>
          <p class="subtitle" data-i18n="subtitle">扫码或手动输入配对码，完成 App 与本机的连接。</p>
          <div class="meta-grid">
            <div class="meta">
              <span class="meta-label" data-i18n="metaLocalUrl">本地地址</span>
              <div class="meta-value">${escapeHtml(currentUrl)}</div>
            </div>
            <div class="meta">
              <span class="meta-label">Link ID</span>
              <div class="meta-value">${escapeHtml(linkId)}</div>
            </div>
            <div class="meta">
              <span class="meta-label" data-i18n="metaConnectToken">配对码</span>
              <div class="meta-value">${escapeHtml(session.code)}</div>
            </div>
            <div class="meta">
              <span class="meta-label" data-i18n="metaExpires">过期时间</span>
              <div class="meta-value" id="expiresValue" data-iso="${escapeHtml(session.expires_at)}">${escapeHtml(formatDate(session.expires_at))}</div>
            </div>
          </div>
          <div class="steps">
            <div class="step">
              <div class="step-badge">1</div>
              <div>
                <p class="step-title" data-i18n="step1Title">在 App 里打开&ldquo;连接 Hermes Link&rdquo;</p>
                <p class="step-copy" data-i18n="step1Copy">在 App 里找到&ldquo;连接 Link&rdquo;入口，选择扫码或手动输入配对码。配对成功后，App 会自动切到这台 Link。</p>
              </div>
            </div>
            <div class="step">
              <div class="step-badge">2</div>
              <div>
                <p class="step-title" data-i18n="step2Title">扫二维码，或手动填写地址和配对码</p>
                <p class="step-copy" data-i18n="step2Copy">如果扫码不方便，可在 App 里手动输入下方的地址和配对码完成连接。</p>
              </div>
            </div>
            <div class="step">
              <div class="step-badge">3</div>
              <div>
                <p class="step-title" data-i18n="step3Title">配对成功后，这个页面会自动变成已完成状态</p>
                <p class="step-copy" id="statusHint">打开 App 扫码，或者复制配对码手动输入。</p>
              </div>
            </div>
          </div>
          <p class="hint" data-i18n="hint">可在终端继续保留这个页面，方便稍后核对状态；如果配对已经成功，页面不会再要求重新扫码。</p>
        </div>
        <div class="qr">
          <div class="card">
            <div class="status">
              <h2 class="status-title" id="statusTitle">等待 App 扫码</h2>
              <span class="pill" id="statusPill">等待中</span>
            </div>
            <div class="qr-frame">
              <img src="${qrDataUri}" alt="Hermes Link pairing QR code" />
            </div>
            <div class="manual">
              <div class="manual-row">
                <span class="manual-label" data-i18n="manualAddrLabel">地址（任选一个可用的）</span>
                ${session.preferred_urls.map((u) => `<span class="manual-value">${escapeHtml(u)}</span>`).join("\n                ")}
              </div>
              <div class="manual-row">
                <span class="manual-label" data-i18n="manualTokenLabel">配对码</span>
                <span class="manual-value code">${escapeHtml(session.code)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </main>
  <script>
    const sessionId = ${JSON.stringify(session.session_id)};
    const expiresAtMs = ${Number.isFinite(expiresAtMs) ? String(expiresAtMs) : "Number.NaN"};
    const initialClaimed = ${JSON.stringify(claimed)};

    const T = {
      zh: {
        h1: '在 App 里完成这次配对',
        subtitle: '扫码或手动输入配对码，完成 App 与本机的连接。',
        metaLocalUrl: '本地地址',
        metaConnectToken: '配对码',
        metaExpires: '过期时间',
        step1Title: '在 App 里打开“连接 Hermes Link”',
        step1Copy: '在 App 里找到“连接 Link”入口，选择扫码或手动输入配对码。配对成功后，App 会自动切到这台 Link。',
        step2Title: '扫二维码，或手动填写地址和配对码',
        step2Copy: '如果扫码不方便，可在 App 里手动输入下方的地址和配对码完成连接。',
        step3Title: '配对成功后，这个页面会自动变成已完成状态',
        hint: '可在终端继续保留这个页面，方便稍后核对状态；如果配对已经成功，页面不会再要求重新扫码。',
        manualAddrLabel: '地址（任选一个可用的）',
        manualTokenLabel: '配对码',
        status_waiting: '等待 App 扫码',
        status_claimed: '已完成配对',
        status_expired: '配对已过期',
        pill_waiting: '等待中',
        pill_claimed: '已扫码',
        pill_expired: '已过期',
        hint_waiting: '打开 App 扫码，或者复制配对码手动输入。',
        hint_claimed: 'App 已完成配对，这个页面可以关闭。',
        hint_expired: '这次二维码已过期，请重新运行 hermeslink pair。',
        expires_locale: 'zh-CN',
        langToggle: 'EN',
      },
      en: {
        h1: 'Complete Pairing in the App',
        subtitle: 'Scan the QR code or enter the connect token to link this device.',
        metaLocalUrl: 'Local Address',
        metaConnectToken: 'Connect Token',
        metaExpires: 'Expires',
        step1Title: 'Open “Connect Hermes Link” in the App',
        step1Copy: 'Find the “Connect Link” entry in the App, then scan the QR code or enter the token manually. The App will switch to this Link automatically after pairing.',
        step2Title: 'Scan the QR code, or enter the address and token manually',
        step2Copy: 'If scanning is inconvenient, enter the address and connect token below in the App.',
        step3Title: 'This page will update automatically once pairing is complete',
        hint: 'You can keep this page open to check pairing status later. If pairing has already succeeded, the page will not prompt for a re-scan.',
        manualAddrLabel: 'Address (pick any that works)',
        manualTokenLabel: 'Connect Token',
        status_waiting: 'Waiting for App to Scan',
        status_claimed: 'Pairing Complete',
        status_expired: 'Pairing Expired',
        pill_waiting: 'Waiting',
        pill_claimed: 'Scanned',
        pill_expired: 'Expired',
        hint_waiting: 'Open the App to scan, or copy the connect token for manual entry.',
        hint_claimed: 'Pairing complete. You can close this page.',
        hint_expired: 'This QR code has expired. Please run hermeslink pair again.',
        expires_locale: 'en-US',
        langToggle: '中文',
      },
    };

    let lang = localStorage.getItem('hl-lang') || 'en';
    let state = ${JSON.stringify(initialState)};

    const statusTitleEl = document.querySelector('#statusTitle');
    const statusPillEl = document.querySelector('#statusPill');
    const statusHintEl = document.querySelector('#statusHint');
    const langToggleEl = document.querySelector('#langToggle');
    const expiresEl = document.querySelector('#expiresValue');

    function applyLang() {
      const s = T[lang];
      document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (s[key] !== undefined) el.textContent = s[key];
      });
      statusTitleEl.textContent = s['status_' + state];
      statusPillEl.textContent = s['pill_' + state];
      statusHintEl.textContent = s['hint_' + state];
      if (expiresEl) {
        const iso = expiresEl.dataset.iso;
        const d = new Date(iso);
        expiresEl.textContent = isFinite(d.getTime())
          ? d.toLocaleString(s.expires_locale, { hour12: lang === 'en' })
          : iso;
      }
      langToggleEl.textContent = s.langToggle;
    }

    langToggleEl.addEventListener('click', () => {
      lang = lang === 'zh' ? 'en' : 'zh';
      localStorage.setItem('hl-lang', lang);
      applyLang();
    });

    applyLang();

    let refreshTimer = null;
    const stopPolling = () => { if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; } };

    const markClaimed = () => { state = 'claimed'; applyLang(); stopPolling(); };
    const markExpired = () => { state = 'expired'; applyLang(); stopPolling(); };

    const refresh = async () => {
      if (Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs) { markExpired(); return; }
      try {
        const response = await fetch('/api/v1/pairing/session?session_id=' + encodeURIComponent(sessionId), { headers: { accept: 'application/json' } });
        if (response.status === 404) { markExpired(); return; }
        if (!response.ok) return;
        const payload = await response.json();
        if (payload?.session?.claimed) markClaimed();
      } catch {}
    };

    if (!initialClaimed) {
      refreshTimer = setInterval(refresh, 2000);
    }
  </script>
</body>
</html>`;
}
