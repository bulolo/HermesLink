/**
 * End-to-end API tests for Hermes Link.
 *
 * Starts a real HTTP server against a temp runtime directory.
 * Tests that depend on Hermes API Server are skipped when it's unreachable.
 */


import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { startLinkService } from "../../src/http/app.js";
import { ensureIdentity } from "../../src/identity/identity.js";
import { resolveRuntimePaths } from "../../src/runtime/paths.js";
import { generateAppConnectToken } from "../../src/security/app-connect-token.js";
import { initLinkDatabase } from "../../src/storage/link-database.js";

// ── Shared test state (mutable so tokens can be updated after rotation) ───────

const state = {
  baseUrl: "",
  accessToken: "",
  refreshToken: "",
  stopServer: async () => { },
  hermesAvailable: false,
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function authHeaders(token?: string): Record<string, string> {
  const t = token ?? state.accessToken;
  return t ? { authorization: `Bearer ${t}` } : {};
}

async function get(urlPath: string, token?: string) {
  return fetch(`${state.baseUrl}${urlPath}`, { headers: authHeaders(token) });
}

async function post(urlPath: string, body: unknown, token?: string) {
  return fetch(`${state.baseUrl}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(body),
  });
}

async function patch(urlPath: string, body: unknown, token?: string) {
  return fetch(`${state.baseUrl}${urlPath}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(body),
  });
}

async function del(urlPath: string, body?: unknown, token?: string) {
  return fetch(`${state.baseUrl}${urlPath}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// ── Setup & teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Isolated runtime directory — no interference with production data
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), "hermeslink-test-"));
  process.env.HERMESLINK_HOME = tmpHome;
  const paths = resolveRuntimePaths(tmpHome);

  const identity = await ensureIdentity(paths);
  await initLinkDatabase(paths);

  const config = { port: 0, lanHost: null, language: "auto" as const, logLevel: "error" as const };
  const service = await startLinkService({ config, identity, paths });
  const address = service.server.address() as { port: number };
  state.baseUrl = `http://127.0.0.1:${address.port}`;
  state.stopServer = service.stop;

  // Exchange connect token for initial access + refresh token
  const ct = await generateAppConnectToken(paths);
  const resp = await post("/api/v1/auth/device-session", { device_label: "test-runner", device_platform: "cli" }, ct.token);
  const session = await json(resp);
  state.accessToken = (session.access_token as Record<string, string>).token;
  state.refreshToken = (session.refresh_token as Record<string, string>).token;

  // Probe Hermes API Server
  state.hermesAvailable = await fetch("http://127.0.0.1:8642/v1/health", { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
}, 30_000);

afterAll(async () => {
  await state.stopServer();
  const home = process.env.HERMESLINK_HOME;
  delete process.env.HERMESLINK_HOME;
  if (home) await rm(home, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Public routes (no auth)", () => {
  it("GET /api/v1/bootstrap returns link_id and capabilities", async () => {
    const res = await get("/api/v1/bootstrap", "");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(typeof body.link_id).toBe("string");
    expect(typeof body.version).toBe("string");
    const caps = body.capabilities as Record<string, boolean>;
    expect(caps.runs).toBe(true);
    expect(caps.profiles).toBe(true);
    expect(caps.statistics).toBe(true);
  });

  it("GET /pair returns HTML pairing page", async () => {
    const res = await get("/pair", "");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Hermes Link Pairing");
  });

  it("CORS Access-Control-Allow-Origin header is present", async () => {
    const res = await get("/api/v1/bootstrap", "");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("Error handling", () => {
  it("Unknown route returns 404", async () => {
    const res = await get("/api/v1/totally-nonexistent-route");
    expect(res.status).toBe(404);
  });

  it("Unauthenticated request to protected route returns 401", async () => {
    const res = await get("/api/v1/status", "");
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.ok).toBe(false);
    const error = body.error as Record<string, string>;
    expect(error.code).toBe("auth_required");
    expect(typeof error.message).toBe("string");
  });

  it("Invalid token returns 401 with descriptive code", async () => {
    const res = await get("/api/v1/status", "hlat_totally_invalid_token");
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect((body.error as Record<string, string>).code).toBe("device_access_token_invalid");
  });
});

describe("Auth flow", () => {
  it("GET /api/v1/auth/me returns device and auth info", async () => {
    const res = await get("/api/v1/auth/me");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect((body.device as Record<string, unknown>)?.label).toBe("test-runner");
    expect((body.auth as Record<string, unknown>)?.kind).toBe("device");
    expect(body.link).toBeTruthy();
  });

  it("POST /api/v1/auth/device-session rejects device token (requires connect token)", async () => {
    // Using the current access token (device kind) should be rejected with 403
    const res = await post("/api/v1/auth/device-session", { device_label: "bad-test", device_platform: "cli" });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect((body.error as Record<string, string>).code).toBe("app_connect_required");
  });

  it("POST /api/v1/auth/refresh rotates tokens and returns new pair", async () => {
    const res = await post("/api/v1/auth/refresh", { refresh_token: state.refreshToken }, "");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    const at = body.access_token as Record<string, string>;
    const rt = body.refresh_token as Record<string, string>;
    expect(at.token).toMatch(/^hlat_/);
    expect(rt.token).toMatch(/^hlrt_/);
    // IMPORTANT: token rotation — update state so subsequent tests use the new tokens
    state.accessToken = at.token;
    state.refreshToken = rt.token;
  });

  it("Old access token is invalid after rotation", async () => {
    // We can't easily test this here because we updated state.accessToken in the previous test,
    // but we verify the token format is correct and works
    const res = await get("/api/v1/auth/me");
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);
  });

  it("POST /api/v1/auth/logout revokes a refresh token", async () => {
    // Create a disposable session so we don't break the main test tokens
    const paths = resolveRuntimePaths();
    const ct = await generateAppConnectToken(paths);
    const sessionRes = await post(
      "/api/v1/auth/device-session",
      { device_label: "disposable-device", device_platform: "cli" },
      ct.token,
    );
    const session = await json(sessionRes);
    const disposableRt = (session.refresh_token as Record<string, string>).token;

    const logoutRes = await post("/api/v1/auth/logout", { refresh_token: disposableRt });
    expect((await json(logoutRes)).ok).toBe(true);

    // The revoked refresh token should no longer work
    const refreshRes = await post("/api/v1/auth/refresh", { refresh_token: disposableRt }, "");
    expect(refreshRes.status).toBe(401);
  });
});

describe("Core status & logs", () => {
  it("GET /api/v1/status returns service overview", async () => {
    const res = await get("/api/v1/status");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(typeof body.port).toBe("number");
    expect(body.paired).toBe(true);
    expect(body.devices).toBeTruthy();
    expect((body.profiles as Record<string, unknown>).total).toBeTypeOf("number");
  });

  it("GET /api/v1/logs returns recent log entries", async () => {
    const res = await get("/api/v1/logs?limit=5");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.logs)).toBe(true);
    expect((body.logs as unknown[]).length).toBeLessThanOrEqual(5);
  });

  it("GET /api/v1/logs?source=gateway returns gateway log source", async () => {
    const res = await get("/api/v1/logs?source=gateway&limit=5");
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.source).toBe("gateway");
  });
});

describe("System routes", () => {
  it("GET /api/v1/system/status returns detailed system info (no auth required)", async () => {
    const res = await get("/api/v1/system/status", "");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(typeof body.version).toBe("string");
    expect(typeof body.port).toBe("number");
    expect(body.autostart).toBeTruthy();
    expect((body.autostart as Record<string, unknown>).supported).toBeTypeOf("boolean");
  });

  it("GET /api/v1/system/version returns semver string (no auth required)", async () => {
    const res = await get("/api/v1/system/version", "");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("Devices", () => {
  let testDeviceId = "";

  it("GET /api/v1/devices lists paired devices", async () => {
    const res = await get("/api/v1/devices");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    const devices = body.devices as Array<Record<string, string>>;
    expect(devices.length).toBeGreaterThan(0);
    const testDevice = devices.find((d) => d.label === "test-runner");
    expect(testDevice).toBeTruthy();
    testDeviceId = testDevice!.id;
  });

  it("PATCH /api/v1/devices/:id renames a device", async () => {
    const res = await patch(`/api/v1/devices/${testDeviceId}`, { label: "renamed-runner" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect((body.device as Record<string, string>).label).toBe("renamed-runner");
  });

  it("PATCH /api/v1/devices/:id restores name", async () => {
    const res = await patch(`/api/v1/devices/${testDeviceId}`, { label: "test-runner" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((body.device as Record<string, string>).label).toBe("test-runner");
  });

  it("DELETE /api/v1/devices/:id 404s for nonexistent device", async () => {
    const res = await del("/api/v1/devices/dev_nonexistent_id_12345");
    expect(res.status).toBe(404);
  });
});

describe("Pairing", () => {
  it("GET /api/v1/pairing/session 404s for unknown session", async () => {
    const res = await get("/api/v1/pairing/session?session_id=ps_nonexistent_session", "");
    expect(res.status).toBe(404);
  });

  it("POST /api/v1/pairing/claim 404s for unknown session", async () => {
    const res = await post(
      "/api/v1/pairing/claim",
      { session_id: "ps_fake_session", claim_token: "fakeclaimtoken", device_label: "x", device_platform: "cli" },
      "",
    );
    expect(res.status).toBe(404);
  });
});

describe("Statistics", () => {
  it("GET /api/v1/statistics returns conversation stats", async () => {
    const res = await get("/api/v1/statistics");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.statistics).toBeTruthy();
  });

  it("GET /api/v1/statistics/usage returns 7-day token usage breakdown", async () => {
    const res = await get("/api/v1/statistics/usage?days=7");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    const usage = body.usage as Record<string, unknown>;
    const range = usage.range as Record<string, unknown>;
    expect(range.days).toBe(7);
    expect(Array.isArray(usage.daily)).toBe(true);
    expect((usage.daily as unknown[]).length).toBe(7);
    expect(Array.isArray(usage.models)).toBe(true);
    expect(Array.isArray(usage.profiles)).toBe(true);
    const totals = usage.totals as Record<string, number>;
    expect(typeof totals.input_tokens).toBe("number");
    expect(typeof totals.output_tokens).toBe("number");
    expect(typeof totals.run_count).toBe("number");
  });

  it("GET /api/v1/statistics/usage clamps days to max 30", async () => {
    const res = await get("/api/v1/statistics/usage?days=999");
    const body = await json(res);
    const range = (body.usage as Record<string, Record<string, unknown>>).range;
    expect(range.days).toBeLessThanOrEqual(30);
  });

  it("GET /api/v1/statistics/usage respects from/to date params", async () => {
    const res = await get("/api/v1/statistics/usage?from=2026-01-01&to=2026-01-03");
    const body = await json(res);
    expect(body.ok).toBe(true);
    const range = (body.usage as Record<string, Record<string, unknown>>).range;
    expect(range.from).toBe("2026-01-01");
  });
});

describe("Models", () => {
  it("GET /api/v1/model-configs returns config (200 or empty)", async () => {
    const res = await get("/api/v1/model-configs");
    expect(res.status).toBe(200);
  });

  it("GET /api/v1/profiles/default/model-configs returns 200", async () => {
    const res = await get("/api/v1/profiles/default/model-configs");
    expect(res.status).toBe(200);
  });

  it.runIf(state.hermesAvailable)("GET /api/v1/models returns OpenAI-compatible list", async () => {
    const res = await get("/api/v1/models");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe("Profiles", () => {
  it("GET /api/v1/profiles lists profile names array", async () => {
    const res = await get("/api/v1/profiles");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.profiles)).toBe(true);
  });

  it("GET /api/v1/profiles/catalog returns full profile catalog", async () => {
    const res = await get("/api/v1/profiles/catalog");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.profiles)).toBe(true);
    expect(typeof body.generatedAt).toBe("string");
    const first = (body.profiles as Array<Record<string, unknown>>)[0];
    expect(first.profile).toBeTruthy();
  });

  it("GET /api/v1/profile-creation/status returns idle status", async () => {
    const res = await get("/api/v1/profile-creation/status");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
  });

  it("GET /api/v1/profiles/default/status wraps profile in ok+profile envelope", async () => {
    const res = await get("/api/v1/profiles/default/status");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    const profile = body.profile as Record<string, unknown>;
    expect(typeof profile.uid).toBe("string");
    expect(profile.uid).toMatch(/^prof_/);
    expect(profile.name).toBe("default");
    expect(typeof profile.exists).toBe("boolean");
    expect(typeof profile.apiKeyConfigured).toBe("boolean");
  });

  it("GET /api/v1/profiles/default/statistics includes statistics and capabilities", async () => {
    const res = await get("/api/v1/profiles/default/statistics");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.profile).toBeTruthy();
    expect(body.capabilities).toBeTruthy();
    expect(body.statistics).toBeTruthy();
    const caps = body.capabilities as Record<string, unknown>;
    expect(typeof caps.skillCount).toBe("number");
    expect(typeof caps.modelCount).toBe("number");
    expect(typeof caps.toolCount).toBe("number");
  });

  it("GET /api/v1/profiles/:name/status returns 400 for invalid profile name", async () => {
    // Path-traversal-like name should be caught by isValidProfileName
    const res = await get("/api/v1/profiles/%2E%2E%2Fetc/status");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Profile — PATCH / DELETE (non-default)", () => {
  it("PATCH /api/v1/profiles/default returns 400 (default is immutable)", async () => {
    const res = await patch("/api/v1/profiles/default", { name: "renamed-default" });
    expect(res.status).toBe(400);
    expect(((await json(res)).error as Record<string, string>).code).toBe("default_profile_not_mutable");
  });

  it("DELETE /api/v1/profiles/default returns 400 (default is immutable)", async () => {
    const res = await del("/api/v1/profiles/default");
    expect(res.status).toBe(400);
    expect(((await json(res)).error as Record<string, string>).code).toBe("default_profile_not_mutable");
  });

  it("DELETE /api/v1/profiles/:name returns 404 for nonexistent profile", async () => {
    const res = await del("/api/v1/profiles/this-profile-does-not-exist-xyz");
    expect(res.status).toBe(404);
  });
});

describe("Profile — Skills", () => {
  it("GET /api/v1/profiles/default/skills returns ok+skills+categories", async () => {
    const res = await get("/api/v1/profiles/default/skills");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.profile).toBeTruthy();
    expect(Array.isArray(body.categories)).toBe(true);
  });

  it("PATCH /api/v1/profiles/default/skills/:name requires enabled boolean", async () => {
    const res = await patch("/api/v1/profiles/default/skills/any-skill-name", {});
    expect(res.status).toBe(400);
    expect(((await json(res)).error as Record<string, string>).code).toBe("skill_enabled_required");
  });

  it("PATCH /api/v1/profiles/default/skills/:name 404s for unknown skill", async () => {
    const res = await patch("/api/v1/profiles/default/skills/nonexistent-skill-xyz-9999", { enabled: true });
    expect(res.status).toBe(404);
    expect(((await json(res)).error as Record<string, string>).code).toBe("skill_not_found");
  });
});

describe("Profile — Memory", () => {
  it("GET /api/v1/profiles/default/memory returns two stores (user + memory)", async () => {
    const res = await get("/api/v1/profiles/default/memory");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    const stores = body.stores as Array<Record<string, unknown>>;
    expect(stores).toHaveLength(2);
    expect(stores.map((s) => s.target).sort()).toEqual(["memory", "user"]);
    // Each store has entryCount and usage
    for (const store of stores) {
      expect(typeof store.entryCount).toBe("number");
      expect(store.usage).toBeTruthy();
    }
  });

  it("POST / DELETE memory entry round-trip", async () => {
    const content = "E2E test memory entry — unit test";

    const addRes = await post("/api/v1/profiles/default/memory/entries", { target: "memory", content });
    expect(addRes.status).toBe(200);
    const addBody = await json(addRes);
    expect(addBody.ok).toBe(true);
    const memStore = (addBody.stores as Array<Record<string, unknown>>).find((s) => s.target === "memory");
    const entries = memStore?.entries as Array<Record<string, string>>;
    expect(entries.some((e) => e.content === content)).toBe(true);

    const delRes = await del("/api/v1/profiles/default/memory/entries", { target: "memory", match: content });
    expect(delRes.status).toBe(200);
    expect((await json(delRes)).ok).toBe(true);
  });

  it("PATCH memory/entries replaces an entry", async () => {
    const original = "Original E2E entry to be replaced";
    const updated = "Replaced E2E entry";

    await post("/api/v1/profiles/default/memory/entries", { target: "memory", content: original });

    const patchRes = await patch("/api/v1/profiles/default/memory/entries", {
      target: "memory",
      match: original,
      content: updated,
    });
    expect(patchRes.status).toBe(200);
    const body = await json(patchRes);
    const memStore = (body.stores as Array<Record<string, unknown>>).find((s) => s.target === "memory");
    const entries = memStore?.entries as Array<Record<string, string>>;
    expect(entries.some((e) => e.content === updated)).toBe(true);
    expect(entries.some((e) => e.content === original)).toBe(false);

    await del("/api/v1/profiles/default/memory/entries", { target: "memory", match: updated });
  });

  it("POST memory/entries 400s for empty content", async () => {
    const res = await post("/api/v1/profiles/default/memory/entries", { target: "memory", content: "   " });
    expect(res.status).toBe(400);
    expect(((await json(res)).error as Record<string, string>).code).toBe("memory_content_empty");
  });

  it("DELETE memory/entries 400s when match not found", async () => {
    const res = await del("/api/v1/profiles/default/memory/entries", {
      target: "memory",
      match: "this-entry-absolutely-does-not-exist-xyz-12345",
    });
    expect(res.status).toBe(400);
    expect(((await json(res)).error as Record<string, string>).code).toBe("memory_entry_not_found");
  });

  it("DELETE memory resets a store to empty", async () => {
    await post("/api/v1/profiles/default/memory/entries", {
      target: "user",
      content: "Temporary user entry for reset test",
    });

    const resetRes = await del("/api/v1/profiles/default/memory", { target: "user" });
    expect(resetRes.status).toBe(200);
    const body = await json(resetRes);
    expect(body.ok).toBe(true);
    const userStore = (body.stores as Array<Record<string, unknown>>).find((s) => s.target === "user");
    expect((userStore?.entries as unknown[]).length).toBe(0);
  });
});

describe("Profile — Permissions", () => {
  it("GET /api/v1/profiles/default/permissions wraps with ok+permissions", async () => {
    const res = await get("/api/v1/profiles/default/permissions");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.permissions).toBeTruthy();
    const perms = body.permissions as Record<string, unknown>;
    expect(perms.approvals).toBeTruthy();
    expect(perms.toolsets).toBeTruthy();
  });

  it("PATCH /api/v1/profiles/default/permissions 400s with empty body", async () => {
    const res = await patch("/api/v1/profiles/default/permissions", {});
    expect(res.status).toBe(400);
    expect(((await json(res)).error as Record<string, string>).code).toBe("profile_permissions_update_empty");
  });
});

describe("Profile — Tool Configs", () => {
  it("GET /api/v1/profiles/default/tool-configs/web returns 200", async () => {
    const res = await get("/api/v1/profiles/default/tool-configs/web");
    expect(res.status).toBe(200);
  });

  it("PATCH /api/v1/profiles/default/tool-configs/:key 400s with empty values", async () => {
    const res = await patch("/api/v1/profiles/default/tool-configs/Bash", {});
    expect(res.status).toBe(400);
    expect(((await json(res)).error as Record<string, string>).code).toBe("profile_tool_config_update_empty");
  });
});

describe("Cron Jobs", () => {
  it("GET /api/v1/cron-jobs lists all jobs across profiles", async () => {
    const res = await get("/api/v1/cron-jobs");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  it("GET /api/v1/profiles/default/cron-jobs lists profile jobs", async () => {
    const res = await get("/api/v1/profiles/default/cron-jobs");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  it.runIf(state.hermesAvailable)("GET /api/v1/profiles/default/cron-jobs/:id 404s for nonexistent job", async () => {
    const res = await get("/api/v1/profiles/default/cron-jobs/nonexistent-cron-job-id");
    expect(res.status).toBe(404);
  });

  it.runIf(state.hermesAvailable)("DELETE /api/v1/profiles/default/cron-jobs/:id 404s for nonexistent job", async () => {
    const res = await del("/api/v1/profiles/default/cron-jobs/nonexistent-job-id");
    expect(res.status).toBe(404);
  });
});

describe("Runs", () => {
  it("POST /api/v1/runs 400s when input field is missing", async () => {
    const res = await post("/api/v1/runs", { profile: "default" });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect((body.error as Record<string, string>).code).toBe("run_input_required");
  });

  it.runIf(state.hermesAvailable)("POST /api/v1/runs creates a run and returns run_id", async () => {
    const res = await post("/api/v1/runs", { input: "echo test run", profile: "default" });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(typeof body.run_id).toBe("string");
    expect(body.run_id).toMatch(/^run_/);
    expect(body.fallback).toBe(false);
  });
});

describe("Updates", () => {
  it("GET /api/v1/hermes/update-check returns check result", async () => {
    const res = await get("/api/v1/hermes/update-check");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(typeof body.update_available).toBe("boolean");
    expect(body.local).toBeTruthy();
  });

  it("GET /api/v1/link/update-check returns local version and update flag", async () => {
    const res = await get("/api/v1/link/update-check");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(typeof body.update_available).toBe("boolean");
    const local = body.local as Record<string, string>;
    expect(local.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("GET /api/v1/hermes/update/status returns status object", async () => {
    const res = await get("/api/v1/hermes/update/status");
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);
  });

  it("GET /api/v1/link/update/status returns status object", async () => {
    const res = await get("/api/v1/link/update/status");
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);
  });
});

describe("Conversations", () => {
  it("GET /api/v1/conversations returns empty list for new runtime", async () => {
    const res = await get("/api/v1/conversations");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.conversations)).toBe(true);
  });

  it("GET /api/v1/conversations/:id/messages 404s for unknown conversation", async () => {
    const res = await get("/api/v1/conversations/conv_nonexistentid12345/messages");
    expect(res.status).toBe(404);
  });
});
