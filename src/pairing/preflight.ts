import path from "path";
import { mkdir } from "fs/promises";
import { type LinkIdentity } from "../identity/identity.js";
import { type LinkConfig } from "../config/config.js";
import { generateAppConnectToken } from "../security/app-connect-token.js";
import { type RuntimePaths } from "../runtime/paths.js";
import { writeJsonFile } from "../storage/atomic-json.js";
import { openSystemBrowser } from "../runtime/browser.js";
import { discoverRouteCandidates } from "../network/topology.js";

export interface PairingPreflightResult {
  pairingUrl: string;
  connectToken: string;
  bestUrl: string;
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

  // Discover accessible URLs (LAN + public IP)
  const routes = options.identity.link_id
    ? await discoverRouteCandidates({
        port: options.config.port,
        relayBaseUrl: options.config.relayBaseUrl,
        linkId: options.identity.link_id,
        installId: options.identity.install_id,
        publicKeyPem: options.identity.public_key_pem,
        configuredLanHost: options.config.lanHost,
      }).catch(() => null)
    : null;

  // Pick best accessible URL: prefer LAN/public IP over 127.0.0.1
  const localApiUrl = `http://127.0.0.1:${options.config.port}`;
  const preferredUrls = (routes?.preferredUrls ?? []).filter(
    (u) => !u.includes("/api/v1/relay/"),
  );
  const bestUrl = preferredUrls[0] ?? localApiUrl;

  const sessionId = `ps_${token.token.slice(0, 16)}`;
  const session: LocalPairingSession = {
    session_id: sessionId,
    code: token.token,
    link_id: options.identity.link_id ?? "",
    display_name: "Hermes Link",
    local_api_url: bestUrl,
    server_base_url: options.config.serverBaseUrl,
    relay_base_url: options.config.relayBaseUrl,
    preferred_urls: preferredUrls.length > 0 ? preferredUrls : [localApiUrl],
    created_at: new Date().toISOString(),
    expires_at: token.expiresAt,
  };

  await mkdir(options.paths.pairingDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await writeJsonFile(pairingSessionPath(sessionId, options.paths), session);

  const lanUrls = (routes?.lanIps ?? []).map((ip) => `http://${ip}:${options.config.port}`);
  const publicUrls = (routes?.publicIpv4s ?? []).map((ip) => `http://${ip}:${options.config.port}`);

  const pairingUrl = buildPairingUrl({
    linkId: options.identity.link_id ?? "",
    installId: options.identity.install_id,
    connectToken: token.token,
    port: options.config.port,
    lanUrls,
    publicUrls,
  });

  if (options.openBrowser !== false) {
    await openSystemBrowser(pairingUrl).catch(() => undefined);
  }

  return { pairingUrl, connectToken: token.token, bestUrl };
}

function buildPairingUrl(params: {
  linkId: string;
  installId: string;
  connectToken: string;
  port: number;
  lanUrls: string[];
  publicUrls: string[];
}): string {
  const qs = new URLSearchParams({
    link_id: params.linkId,
    install_id: params.installId,
    connect_token: params.connectToken,
    port: String(params.port),
  });
  if (params.lanUrls.length > 0) qs.set("lan_urls", params.lanUrls.join(","));
  if (params.publicUrls.length > 0) qs.set("public_urls", params.publicUrls.join(","));
  return `hermesapp://pair?${qs.toString()}`;
}

export function buildLocalPairingPageUrl(port: number, connectToken: string): string {
  const qs = new URLSearchParams({ connect_token: connectToken });
  return `http://127.0.0.1:${port}/pair?${qs.toString()}`;
}
