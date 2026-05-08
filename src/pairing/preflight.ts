import path from "path";
import { mkdir } from "fs/promises";
import { type LinkIdentity } from "../identity/identity.js";
import { type LinkConfig } from "../config/config.js";
import { generateAppConnectToken } from "../security/app-connect-token.js";
import { type RuntimePaths } from "../runtime/paths.js";
import { writeJsonFile } from "../storage/atomic-json.js";
import { openSystemBrowser } from "../runtime/browser.js";
import { discoverRouteCandidates } from "../network/topology.js";

export interface PairingQrPayload {
  kind: "hermes_link_pairing";
  version: 1;
  link_id: string;
  display_name: string;
  session_id: string;
  code: string;
  preferred_urls: string[];
}

export interface PairingPreflightResult {
  /** App 扫码用的 QR 内容（JSON 字符串） */
  qrPayload: string;
  /** 浏览器打开的本地配对网页 URL */
  pageUrl: string;
  connectToken: string;
  sessionId: string;
  preferredUrls: string[];
}

interface LocalPairingSession {
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

export async function runPairingPreflight(options: {
  identity: LinkIdentity;
  config: LinkConfig;
  paths: RuntimePaths;
  openBrowser?: boolean;
}): Promise<PairingPreflightResult> {
  const token = await generateAppConnectToken(options.paths);

  // 发现本机可访问的 URL（局域网 IP + 公网 IP）
  const routes = await discoverRouteCandidates({
    port: options.config.port,
    configuredLanHost: options.config.lanHost,
  }).catch(() => null);

  const localApiUrl = `http://127.0.0.1:${options.config.port}`;
  const preferredUrls = (routes?.preferredUrls ?? []).length > 0
    ? routes!.preferredUrls
    : [localApiUrl];

  const sessionId = `ps_${token.token.slice(0, 16)}`;

  const session: LocalPairingSession = {
    session_id: sessionId,
    code: token.token,
    link_id: options.identity.link_id ?? "",
    display_name: "Hermes Link",
    local_api_url: preferredUrls[0] ?? localApiUrl,
    preferred_urls: preferredUrls,
    created_at: new Date().toISOString(),
    expires_at: token.expiresAt,
  };

  await mkdir(options.paths.pairingDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await writeJsonFile(pairingSessionPath(sessionId, options.paths), session);

  // App 扫码解析的 QR payload（JSON）
  const qrPayload: PairingQrPayload = {
    kind: "hermes_link_pairing",
    version: 1,
    link_id: options.identity.link_id ?? "",
    display_name: "Hermes Link",
    session_id: sessionId,
    code: token.token,
    preferred_urls: preferredUrls,
  };

  const pageUrl = buildLocalPairingPageUrl(options.config.port, sessionId, token.token);

  if (options.openBrowser !== false) {
    await openSystemBrowser(pageUrl).catch(() => undefined);
  }

  return {
    qrPayload: JSON.stringify(qrPayload),
    pageUrl,
    connectToken: token.token,
    sessionId,
    preferredUrls,
  };
}

export function buildLocalPairingPageUrl(port: number, sessionId: string, connectToken: string): string {
  const qs = new URLSearchParams({ session_id: sessionId, connect_token: connectToken });
  return `http://127.0.0.1:${port}/pair?${qs.toString()}`;
}
