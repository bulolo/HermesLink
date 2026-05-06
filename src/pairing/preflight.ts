import path from "path";
import { mkdir } from "fs/promises";
import { type LinkIdentity } from "../identity/identity.js";
import { type LinkConfig } from "../config/config.js";
import { generateAppConnectToken } from "../security/app-connect-token.js";
import { type RuntimePaths } from "../runtime/paths.js";
import { writeJsonFile } from "../storage/atomic-json.js";
import { openSystemBrowser } from "../runtime/browser.js";

export interface PairingPreflightResult {
  pairingUrl: string;
  connectToken: string;
}

interface LocalPairingSession {
  session_id: string;
  code: string;
  link_id: string;
  display_name: string;
  local_api_url: string;
  server_base_url: string;
  relay_base_url: string;
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
  const localApiUrl = `http://127.0.0.1:${options.config.port}`;

  // Write a local pairing session so the /api/v1/pairing/claim route can verify it
  const sessionId = `ps_${token.token.slice(0, 16)}`;
  const session: LocalPairingSession = {
    session_id: sessionId,
    code: token.token,
    link_id: options.identity.link_id ?? "",
    display_name: "Hermes Link",
    local_api_url: localApiUrl,
    server_base_url: options.config.serverBaseUrl,
    relay_base_url: options.config.relayBaseUrl,
    preferred_urls: [localApiUrl],
    created_at: new Date().toISOString(),
    expires_at: token.expiresAt,
  };

  await mkdir(options.paths.pairingDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await writeJsonFile(pairingSessionPath(sessionId, options.paths), session);

  const pairingUrl = buildPairingUrl({
    linkId: options.identity.link_id ?? "",
    installId: options.identity.install_id,
    connectToken: token.token,
    port: options.config.port,
    localApiUrl,
  });

  if (options.openBrowser !== false) {
    await openSystemBrowser(pairingUrl).catch(() => undefined);
  }

  return { pairingUrl, connectToken: token.token };
}

function buildPairingUrl(params: {
  linkId: string;
  installId: string;
  connectToken: string;
  port: number;
  localApiUrl: string;
}): string {
  const qs = new URLSearchParams({
    link_id: params.linkId,
    install_id: params.installId,
    connect_token: params.connectToken,
    port: String(params.port),
    local_url: params.localApiUrl,
  });
  return `hermesapp://pair?${qs.toString()}`;
}

export function buildLocalPairingPageUrl(port: number, connectToken: string): string {
  const qs = new URLSearchParams({ connect_token: connectToken });
  return `http://127.0.0.1:${port}/pair?${qs.toString()}`;
}
