import { randomBytes, randomUUID, timingSafeEqual, createHash } from "crypto";
import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import { readJsonFile, writeJsonFile } from "../storage/atomic-json.js";

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 min
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const DEVICE_SEEN_WRITE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface DeviceRecord {
  id: string;
  label: string;
  platform: string;
  model: string | null;
  scope: string;
  app_instance_hash: string | null;
  access_token_hash: string;
  access_expires_at: string;
  refresh_token_hash: string;
  refresh_expires_at: string;
  revoked_at: string | null;
  app_hidden_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceListItem {
  id: string;
  device_id: string;
  label: string;
  platform: string;
  model: string | null;
  scope: string;
  status: "active" | "revoked";
  paired_at: string;
  created_at: string;
  updated_at: string;
  access_expires_at: string;
  refresh_expires_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  app_hidden_at: string | null;
  app_instance_bound: boolean;
}

export interface CredentialStore {
  devices: DeviceRecord[];
}

export interface DeviceSession {
  device: {
    id: string;
    device_id: string;
    label: string;
    platform: string;
    model: string | null;
    scope: string;
  };
  accessToken: { token: string; expiresAt: string };
  refreshToken: { token: string; expiresAt: string };
}

export interface DeviceSummary {
  total: number;
  active: number;
  revoked: number;
}

function credentialsPath(paths: RuntimePaths): string {
  return paths.credentialsFile;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(24).toString("base64url")}`;
}

export async function readCredentialStore(paths: RuntimePaths): Promise<CredentialStore> {
  const raw = await readJsonFile(credentialsPath(paths));
  if (!raw || typeof raw !== "object") return { devices: [] };
  const store = raw as Partial<CredentialStore>;
  return { devices: Array.isArray(store.devices) ? (store.devices as DeviceRecord[]) : [] };
}

export async function writeCredentialStore(paths: RuntimePaths, store: CredentialStore): Promise<void> {
  await writeJsonFile(credentialsPath(paths), store);
}

function formatDeviceSession(device: DeviceRecord, accessToken: string, refreshToken: string): DeviceSession {
  return {
    device: {
      id: device.id,
      device_id: device.id,
      label: device.label,
      platform: device.platform,
      model: device.model ?? null,
      scope: device.scope,
    },
    accessToken: { token: accessToken, expiresAt: device.access_expires_at },
    refreshToken: { token: refreshToken, expiresAt: device.refresh_expires_at },
  };
}

export function formatDeviceListItem(device: DeviceRecord): DeviceListItem {
  return {
    id: device.id,
    device_id: device.id,
    label: device.label,
    platform: device.platform,
    model: device.model ?? null,
    scope: device.scope,
    status: device.revoked_at ? "revoked" : "active",
    paired_at: device.created_at,
    created_at: device.created_at,
    updated_at: device.updated_at,
    access_expires_at: device.access_expires_at,
    refresh_expires_at: device.refresh_expires_at,
    last_seen_at: device.last_seen_at ?? null,
    revoked_at: device.revoked_at,
    app_hidden_at: device.app_hidden_at ?? null,
    app_instance_bound: Boolean(device.app_instance_hash),
  };
}

async function rotateDeviceSession(
  store: CredentialStore,
  device: DeviceRecord,
  now: Date,
  paths: RuntimePaths,
): Promise<DeviceSession> {
  const accessToken = randomToken("hpat_");
  const refreshToken = randomToken("hprt_");
  device.access_token_hash = sha256(accessToken);
  device.access_expires_at = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString();
  device.refresh_token_hash = sha256(refreshToken);
  device.refresh_expires_at = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString();
  device.last_seen_at = now.toISOString();
  device.updated_at = now.toISOString();
  await writeCredentialStore(paths, store);
  return formatDeviceSession(device, accessToken, refreshToken);
}

function hashAppInstanceId(value: string | null | undefined): string | null {
  const normalized = normalizeAppInstanceId(value);
  return normalized ? sha256(`hermespilot-app-instance:${normalized}`) : null;
}

function normalizeAppInstanceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^appi_[A-Za-z0-9_-]{16,96}$/u.test(trimmed) ? trimmed : null;
}

function normalizeDeviceLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 128) : "HermesPilot App";
}

function normalizeDevicePlatform(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed.slice(0, 48) : "unknown";
}

function normalizeDeviceModel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 128) : null;
}

function isDeviceVisibleInApp(device: DeviceRecord): boolean {
  return !device.app_hidden_at;
}

function maybeBindAppInstance(
  store: CredentialStore,
  device: DeviceRecord,
  appInstanceId: string | null | undefined,
): boolean {
  const appInstanceHash = hashAppInstanceId(appInstanceId);
  if (!appInstanceHash || device.app_instance_hash === appInstanceHash) return false;
  if (device.app_instance_hash) return false;
  const existing = store.devices.find((d) => d.id !== device.id && d.app_instance_hash === appInstanceHash);
  if (existing) return false;
  device.app_instance_hash = appInstanceHash;
  return true;
}

function updateDeviceDescriptor(
  device: DeviceRecord,
  input: { label?: string | null; platform?: string | null; model?: string | null },
): boolean {
  let changed = false;
  if (input.label !== undefined && input.label !== null) {
    const label = normalizeDeviceLabel(input.label);
    if (device.label !== label) { device.label = label; changed = true; }
  }
  if (input.platform !== undefined && input.platform !== null) {
    const platform = normalizeDevicePlatform(input.platform);
    if (device.platform !== platform) { device.platform = platform; changed = true; }
  }
  if (input.model !== undefined && input.model !== null) {
    const model = normalizeDeviceModel(input.model);
    if ((device.model ?? null) !== model) { device.model = model; changed = true; }
  }
  return changed;
}

export async function createDeviceSession(
  input: { label: string; platform: string; model?: string | null; appInstanceId?: string | null },
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<DeviceSession> {
  const store = await readCredentialStore(paths);
  const now = new Date();
  const appInstanceHash = hashAppInstanceId(input.appInstanceId);
  if (appInstanceHash) {
    const existing = store.devices.find((d) => d.app_instance_hash === appInstanceHash);
    if (existing) {
      updateDeviceDescriptor(existing, input);
      existing.revoked_at = null;
      existing.app_hidden_at = null;
      return rotateDeviceSession(store, existing, now, paths);
    }
  }
  const device: DeviceRecord = {
    id: `dev_${randomUUID().replaceAll("-", "")}`,
    label: normalizeDeviceLabel(input.label),
    platform: normalizeDevicePlatform(input.platform),
    model: normalizeDeviceModel(input.model),
    scope: "admin",
    app_instance_hash: appInstanceHash,
    access_token_hash: "",
    access_expires_at: "",
    refresh_token_hash: "",
    refresh_expires_at: "",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    revoked_at: null,
    app_hidden_at: null,
  };
  store.devices.push(device);
  return rotateDeviceSession(store, device, now, paths);
}

export async function refreshDeviceSession(
  refreshToken: string,
  options: { appInstanceId?: string | null; label?: string | null; platform?: string | null; model?: string | null } = {},
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<DeviceSession> {
  const tokenHash = sha256(refreshToken);
  const store = await readCredentialStore(paths);
  const device = store.devices.find((d) => safeEqual(d.refresh_token_hash, tokenHash));
  if (!device || device.revoked_at || Date.parse(device.refresh_expires_at) <= Date.now()) {
    throw Object.assign(new Error("Refresh token is invalid or expired"), { status: 401, code: "refresh_token_invalid" });
  }
  const now = new Date();
  maybeBindAppInstance(store, device, options.appInstanceId);
  updateDeviceDescriptor(device, options);
  return rotateDeviceSession(store, device, now, paths);
}

export async function revokeDeviceRefreshToken(
  refreshToken: string,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<void> {
  const tokenHash = sha256(refreshToken);
  const store = await readCredentialStore(paths);
  const device = store.devices.find((d) => safeEqual(d.refresh_token_hash, tokenHash));
  if (!device || device.revoked_at) return;
  device.revoked_at = new Date().toISOString();
  device.updated_at = device.revoked_at;
  await writeCredentialStore(paths, store);
}

export async function authenticateDeviceAccessToken(
  token: string,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<DeviceRecord | null> {
  const tokenHash = sha256(token);
  const store = await readCredentialStore(paths);
  const device = store.devices.find((d) => safeEqual(d.access_token_hash, tokenHash));
  if (!device || device.revoked_at || Date.parse(device.access_expires_at) <= Date.now()) return null;
  return device;
}

export async function recordDeviceSeen(
  deviceId: string,
  options: { appInstanceId?: string | null; model?: string | null } = {},
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<DeviceRecord | null> {
  const store = await readCredentialStore(paths);
  const device = store.devices.find((d) => d.id === deviceId);
  if (!device || device.revoked_at) return device ?? null;
  const now = new Date();
  const bound = maybeBindAppInstance(store, device, options.appInstanceId);
  const descriptorUpdated = updateDeviceDescriptor(device, { model: options.model });
  const shouldTouch =
    !device.last_seen_at ||
    Number.isNaN(Date.parse(device.last_seen_at)) ||
    now.getTime() - Date.parse(device.last_seen_at) >= DEVICE_SEEN_WRITE_INTERVAL_MS;
  if (bound || descriptorUpdated || shouldTouch) {
    device.last_seen_at = now.toISOString();
    device.updated_at = now.toISOString();
    await writeCredentialStore(paths, store);
  }
  return device;
}

export async function listDevices(paths: RuntimePaths = resolveRuntimePaths()): Promise<DeviceListItem[]> {
  const store = await readCredentialStore(paths);
  return store.devices
    .filter(isDeviceVisibleInApp)
    .map(formatDeviceListItem)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      return Date.parse(b.created_at) - Date.parse(a.created_at);
    });
}

export async function readDeviceSummary(paths: RuntimePaths = resolveRuntimePaths()): Promise<DeviceSummary> {
  const store = await readCredentialStore(paths);
  const visible = store.devices.filter(isDeviceVisibleInApp);
  const revoked = visible.filter((d) => d.revoked_at).length;
  return { total: visible.length, active: visible.length - revoked, revoked };
}

export async function revokeDeviceById(
  deviceId: string,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<DeviceListItem> {
  const store = await readCredentialStore(paths);
  const device = store.devices.find((d) => d.id === deviceId);
  if (!device) {
    throw Object.assign(new Error("Device was not found"), { status: 404, code: "device_not_found" });
  }
  if (!device.revoked_at) {
    device.revoked_at = new Date().toISOString();
    device.updated_at = device.revoked_at;
    await writeCredentialStore(paths, store);
  }
  return formatDeviceListItem(device);
}

export async function hideRevokedDeviceFromAppList(
  deviceId: string,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<DeviceListItem> {
  const store = await readCredentialStore(paths);
  const device = store.devices.find((d) => d.id === deviceId);
  if (!device) {
    throw Object.assign(new Error("Device was not found"), { status: 404, code: "device_not_found" });
  }
  if (!device.revoked_at) {
    throw Object.assign(new Error("Device must be revoked before it can be deleted from the app list"), {
      status: 409,
      code: "device_still_active",
    });
  }
  if (!device.app_hidden_at) {
    device.app_hidden_at = new Date().toISOString();
    device.updated_at = device.app_hidden_at;
    await writeCredentialStore(paths, store);
  }
  return formatDeviceListItem(device);
}

export async function renameDeviceById(
  deviceId: string,
  label: string,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<DeviceListItem> {
  const normalizedLabel = label.trim();
  if (!normalizedLabel || normalizedLabel.length > 128) {
    throw Object.assign(new Error("Device label is invalid"), { status: 400, code: "device_label_invalid" });
  }
  const store = await readCredentialStore(paths);
  const device = store.devices.find((d) => d.id === deviceId);
  if (!device) {
    throw Object.assign(new Error("Device was not found"), { status: 404, code: "device_not_found" });
  }
  if (device.revoked_at) {
    throw Object.assign(new Error("Device is revoked"), { status: 409, code: "device_revoked" });
  }
  device.label = normalizedLabel.slice(0, 128);
  device.updated_at = new Date().toISOString();
  await writeCredentialStore(paths, store);
  return formatDeviceListItem(device);
}
