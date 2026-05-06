import crypto from "crypto";
import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import { readJsonFile, writeJsonFile } from "../storage/atomic-json.js";
import path from "path";

const DEVICES_FILE = "trusted-devices.json";

export interface TrustedDevice {
  deviceId: string;
  label: string | null;
  addedAt: string;
  lastSeenAt: string | null;
}

export interface DeviceRegistry {
  devices: TrustedDevice[];
}

function devicesFilePath(paths: RuntimePaths): string {
  return path.join(paths.homeDir, DEVICES_FILE);
}

export async function readTrustedDevices(paths?: RuntimePaths): Promise<TrustedDevice[]> {
  const runtimePaths = paths ?? resolveRuntimePaths();
  const raw = await readJsonFile(devicesFilePath(runtimePaths));
  if (!raw || typeof raw !== "object") return [];
  const reg = raw as Partial<DeviceRegistry>;
  if (!Array.isArray(reg.devices)) return [];
  return reg.devices.filter(isValidDevice);
}

function isValidDevice(value: unknown): value is TrustedDevice {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<TrustedDevice>;
  return typeof d.deviceId === "string" && typeof d.addedAt === "string";
}

export async function trustDevice(
  deviceId: string,
  label: string | null,
  paths?: RuntimePaths,
): Promise<TrustedDevice> {
  const runtimePaths = paths ?? resolveRuntimePaths();
  const devices = await readTrustedDevices(runtimePaths);
  const existing = devices.find((d) => d.deviceId === deviceId);
  if (existing) {
    existing.lastSeenAt = new Date().toISOString();
    if (label) existing.label = label;
    await saveDevices(devices, runtimePaths);
    return existing;
  }
  const device: TrustedDevice = {
    deviceId,
    label,
    addedAt: new Date().toISOString(),
    lastSeenAt: null,
  };
  devices.push(device);
  await saveDevices(devices, runtimePaths);
  return device;
}

export async function revokeDevice(deviceId: string, paths?: RuntimePaths): Promise<boolean> {
  const runtimePaths = paths ?? resolveRuntimePaths();
  const devices = await readTrustedDevices(runtimePaths);
  const index = devices.findIndex((d) => d.deviceId === deviceId);
  if (index === -1) return false;
  devices.splice(index, 1);
  await saveDevices(devices, runtimePaths);
  return true;
}

export async function isDeviceTrusted(deviceId: string, paths?: RuntimePaths): Promise<boolean> {
  const devices = await readTrustedDevices(paths);
  return devices.some((d) => d.deviceId === deviceId);
}

export async function recordDeviceSeen(deviceId: string, paths?: RuntimePaths): Promise<void> {
  const runtimePaths = paths ?? resolveRuntimePaths();
  const devices = await readTrustedDevices(runtimePaths);
  const device = devices.find((d) => d.deviceId === deviceId);
  if (device) {
    device.lastSeenAt = new Date().toISOString();
    await saveDevices(devices, runtimePaths);
  }
}

async function saveDevices(devices: TrustedDevice[], paths: RuntimePaths): Promise<void> {
  await writeJsonFile(devicesFilePath(paths), { devices });
}

export function generateDeviceId(): string {
  return crypto.randomUUID();
}
