import Router from "@koa/router";
import { type RuntimePaths } from "../../runtime/paths.js";
import { loadIdentity } from "../../identity/identity.js";
import { loadConfig } from "../../config/config.js";
import { discoverRouteCandidates } from "../../network/topology.js";
import { LINK_VERSION } from "../../constants.js";

function routeObjects(urls: string[]): { url: string; kind: string }[] {
  return urls.map((url) => ({
    url,
    kind: url.includes("/api/v1/relay/links/") ? "relay" : "lan",
  }));
}

export function createBootstrapRouter(options: { paths: RuntimePaths }): Router {
  const { paths } = options;
  const router = new Router();

  router.get("/api/v1/bootstrap", async (ctx) => {
    const [identity, config] = await Promise.all([loadIdentity(paths), loadConfig(paths)]);
    const routes = identity?.link_id
      ? await discoverRouteCandidates({
          port: config.port,
          relayBaseUrl: config.relayBaseUrl,
          linkId: identity.link_id,
          installId: identity.install_id,
          publicKeyPem: identity.public_key_pem,
          configuredLanHost: config.lanHost,
        })
      : null;
    ctx.set("cache-control", "no-store");
    ctx.body = {
      link_id: identity?.link_id ?? null,
      display_name: identity?.link_id ? "Hermes Link" : "Unpaired Hermes Link",
      version: LINK_VERSION,
      api_version: 1,
      paired: Boolean(identity?.link_id),
      pairing_supported: Boolean(identity?.link_id),
      preferred_pairing_urls: routes?.preferredUrls ?? [],
      routes: routes ? routeObjects(routes.preferredUrls) : [],
      capabilities: {
        runs: true,
        sse: true,
        relay: true,
        profiles: true,
        logs: true,
        statistics: true,
        conversations: true,
        conversation_events: true,
        conversation_delete: true,
        conversation_bulk_delete: true,
        conversation_clear_plan: true,
        conversation_cancel: true,
        conversation_rename: true,
        blobs: true,
        devices: true,
        device_delete: true,
        device_revoke: true,
        device_rename: true,
        device_session_enroll: true,
        cron_jobs: true,
        profile_skills: true,
        profile_memory: true,
        hermes_updates: true,
      },
    };
  });

  return router;
}
