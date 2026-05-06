import { type LinkIdentity, signRelayNonce } from "../identity/identity.js";

export interface RelayBootstrapResult {
  linkId: string;
  token: string;
}

export async function bootstrapWithRelay(options: {
  relayBaseUrl: string;
  identity: LinkIdentity;
  port: number;
  fetchImpl?: typeof fetch;
}): Promise<RelayBootstrapResult> {
  const fetcher = options.fetchImpl ?? fetch;
  const baseUrl = options.relayBaseUrl.replace(/\/+$/u, "");

  // Step 1: Request a nonce
  const nonceResponse = await fetcher(`${baseUrl}/api/v1/relay/links/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ install_id: options.identity.install_id }),
  });
  if (!nonceResponse.ok) {
    throw new Error(`Relay nonce request failed: ${nonceResponse.status}`);
  }
  const nonceBody = (await nonceResponse.json()) as Record<string, unknown>;
  const nonce = typeof nonceBody.nonce === "string" ? nonceBody.nonce : null;
  if (!nonce) {
    throw new Error("Relay did not return a nonce");
  }

  // Step 2: Sign and register
  const signature = signRelayNonce(options.identity, nonce);
  const registerResponse = await fetcher(`${baseUrl}/api/v1/relay/links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      install_id: options.identity.install_id,
      public_key_pem: options.identity.public_key_pem,
      nonce,
      signature,
      port: options.port,
    }),
  });
  if (!registerResponse.ok) {
    throw new Error(`Relay registration failed: ${registerResponse.status}`);
  }
  const registerBody = (await registerResponse.json()) as Record<string, unknown>;
  const linkId = typeof registerBody.link_id === "string" ? registerBody.link_id : null;
  const token = typeof registerBody.token === "string" ? registerBody.token : null;
  if (!linkId || !token) {
    throw new Error("Relay registration response missing link_id or token");
  }
  return { linkId, token };
}

export async function refreshRelayToken(options: {
  relayBaseUrl: string;
  identity: LinkIdentity;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetcher = options.fetchImpl ?? fetch;
  const baseUrl = options.relayBaseUrl.replace(/\/+$/u, "");

  const nonceResponse = await fetcher(`${baseUrl}/api/v1/relay/links/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ install_id: options.identity.install_id }),
  });
  if (!nonceResponse.ok) {
    throw new Error(`Relay nonce request failed: ${nonceResponse.status}`);
  }
  const nonceBody = (await nonceResponse.json()) as Record<string, unknown>;
  const nonce = typeof nonceBody.nonce === "string" ? nonceBody.nonce : null;
  if (!nonce) throw new Error("Relay did not return a nonce");

  const signature = signRelayNonce(options.identity, nonce);
  const tokenResponse = await fetcher(
    `${baseUrl}/api/v1/relay/links/${options.identity.link_id}/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        install_id: options.identity.install_id,
        nonce,
        signature,
      }),
    },
  );
  if (!tokenResponse.ok) {
    throw new Error(`Relay token refresh failed: ${tokenResponse.status}`);
  }
  const tokenBody = (await tokenResponse.json()) as Record<string, unknown>;
  const token = typeof tokenBody.token === "string" ? tokenBody.token : null;
  if (!token) throw new Error("Relay did not return a token");
  return token;
}
