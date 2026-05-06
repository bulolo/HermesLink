import { type LinkIdentity } from "../identity/identity.js";
import { type LinkConfig } from "../config/config.js";
import { generateAppConnectToken } from "../security/app-connect-token.js";
import { type RuntimePaths } from "../runtime/paths.js";
import { openSystemBrowser } from "../runtime/browser.js";

export interface PairingPreflightResult {
  pairingUrl: string;
  connectToken: string;
}

export async function runPairingPreflight(options: {
  identity: LinkIdentity;
  config: LinkConfig;
  paths: RuntimePaths;
  openBrowser?: boolean;
  serverBaseUrl?: string;
}): Promise<PairingPreflightResult> {
  const token = await generateAppConnectToken(options.paths);
  const baseUrl = (options.serverBaseUrl ?? options.config.serverBaseUrl).replace(/\/+$/u, "");
  const pairingUrl = buildPairingUrl(baseUrl, {
    linkId: options.identity.link_id ?? "",
    installId: options.identity.install_id,
    connectToken: token.token,
    port: options.config.port,
  });

  if (options.openBrowser !== false) {
    await openSystemBrowser(pairingUrl).catch(() => undefined);
  }

  return { pairingUrl, connectToken: token.token };
}

function buildPairingUrl(
  serverBaseUrl: string,
  params: {
    linkId: string;
    installId: string;
    connectToken: string;
    port: number;
  },
): string {
  const qs = new URLSearchParams({
    link_id: params.linkId,
    install_id: params.installId,
    connect_token: params.connectToken,
    port: String(params.port),
  });
  return `${serverBaseUrl}/link/pair?${qs.toString()}`;
}

export function buildLocalPairingPageUrl(port: number, connectToken: string): string {
  const qs = new URLSearchParams({ connect_token: connectToken });
  return `http://127.0.0.1:${port}/pair?${qs.toString()}`;
}
