import os from "os";
import { detectRuntimeEnvironment } from "./environment.js";
import { normalizeLanHost } from "../config/config.js";

const VIRTUAL_INTERFACE_NAME_PATTERN =
  /(docker|veth|vmnet|vmenet|vbox|virtualbox|vmware|tailscale|zerotier|wireguard|utun|virbr|hyper-v|vethernet|loopback|\blo\b|^lo\d*$|^br-|^bridge\d+$|^zt|^tun|^tap|awdl|llw|anpi|gif|stf|ipsec|ppp)/iu;
const MAX_LAN_IPS = 4;
const MAX_PUBLIC_IPV4S = 2;
const MAX_PUBLIC_IPV6S = 2;

export interface RouteCandidates {
  lanIps: string[];
  publicIpv4s: string[];
  publicIpv6s: string[];
  preferredUrls: string[];
  environment: ReturnType<typeof detectRuntimeEnvironment>;
}

export async function discoverRouteCandidates(options: {
  configuredLanHost?: string | null;
  relayBaseUrl: string;
  linkId: string;
  port: number;
  installId?: string;
  publicKeyPem?: string;
  relayBootstrapToken?: string;
  observePublicRoute?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<RouteCandidates> {
  const environment = detectRuntimeEnvironment();
  const configuredLanHost = normalizeLanHost(options.configuredLanHost);
  const lanIps = configuredLanHost
    ? [configuredLanHost]
    : environment.lanAutoDiscoveryUsable
      ? discoverLanIps()
      : [];
  const publicIps =
    options.relayBootstrapToken || options.observePublicRoute
      ? await observePublicRoute(options).catch(() => ({ publicIpv4s: [], publicIpv6s: [] }))
      : { publicIpv4s: [], publicIpv6s: [] };
  const publicIpv4s = unique(publicIps.publicIpv4s.filter(isUsablePublicIpv4)).slice(0, MAX_PUBLIC_IPV4S);
  const publicIpv6s = unique(publicIps.publicIpv6s.filter(isUsablePublicIpv6)).slice(0, MAX_PUBLIC_IPV6S);
  const preferredUrls = [
    ...lanIps.map((ip) => buildDirectUrl(ip, options.port)),
    ...publicIpv4s.map((ip) => buildDirectUrl(ip, options.port)),
    ...publicIpv6s.map((ip) => buildDirectUrl(ip, options.port)),
    `${options.relayBaseUrl.replace(/\/+$/u, "")}/api/v1/relay/links/${options.linkId}`,
  ];
  return { lanIps, publicIpv4s, publicIpv6s, preferredUrls, environment };
}

export function discoverLanIps(): string[] {
  return discoverLanIpsFromInterfaces(os.networkInterfaces());
}

function discoverLanIpsFromInterfaces(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string[] {
  const result = new Set<string>();
  const candidates: { name: string; address: string }[] = [];
  for (const [name, items] of Object.entries(interfaces)) {
    if (shouldIgnoreInterface(name)) continue;
    for (const item of items ?? []) {
      if (!item.internal && item.address && item.family === "IPv4" && isUsableLanIpv4(item.address, item.netmask)) {
        candidates.push({ name, address: item.address });
      }
    }
  }
  for (const candidate of candidates.sort(compareLanCandidate)) {
    result.add(candidate.address);
  }
  return [...result].slice(0, MAX_LAN_IPS);
}

async function observePublicRoute(options: {
  relayBaseUrl: string;
  installId?: string;
  linkId?: string;
  publicKeyPem?: string;
  relayBootstrapToken?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ publicIpv4s: string[]; publicIpv6s: string[] }> {
  const fetcher = options.fetchImpl ?? fetch;
  const response = await fetcher(
    `${options.relayBaseUrl.replace(/\/+$/u, "")}/api/v1/relay/public-route/observe`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.relayBootstrapToken ? { authorization: `Bearer ${options.relayBootstrapToken}` } : {}),
      },
      body: JSON.stringify({
        install_id: options.installId,
        link_id: options.linkId,
        public_key_pem: options.publicKeyPem,
      }),
    },
  );
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const record =
    typeof payload?.record === "object" && payload.record !== null
      ? (payload.record as Record<string, unknown>)
      : null;
  const observed =
    typeof payload?.observed === "object" && payload.observed !== null
      ? (payload.observed as Record<string, unknown>)
      : null;
  const values = [
    readIpRecord(record?.ipv4),
    readIpRecord(record?.ipv6),
    typeof observed?.ip === "string" ? observed.ip : null,
  ].filter((v): v is string => Boolean(v));
  return {
    publicIpv4s: unique(values.filter(isUsablePublicIpv4)),
    publicIpv6s: unique(values.filter(isUsablePublicIpv6)),
  };
}

function readIpRecord(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const ip = (value as Record<string, unknown>).ip;
  return typeof ip === "string" && ip.trim() ? ip.trim() : null;
}

function buildDirectUrl(ip: string, port: number): string {
  return `http://${ip.includes(":") ? `[${ip}]` : ip}:${port}`;
}

function shouldIgnoreInterface(name: string): boolean {
  return !name.trim() || VIRTUAL_INTERFACE_NAME_PATTERN.test(name);
}

function compareLanCandidate(left: { name: string; address: string }, right: { name: string; address: string }): number {
  const priority = interfacePriority(left.name) - interfacePriority(right.name);
  return priority || left.name.localeCompare(right.name) || left.address.localeCompare(right.address);
}

function interfacePriority(name: string): number {
  return /^(en|eth|wlan|wi-fi|wifi)/iu.test(name) ? 0 : 1;
}

function isUsableLanIpv4(address: string, netmask: string): boolean {
  return isPrivateIpv4(address) && !isNetworkOrBroadcastIpv4Address(address, netmask);
}

function isUsablePublicIpv4(address: string): boolean {
  return isValidIpv4(address) && !isSpecialIpv4(address);
}

function isUsablePublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized.includes(":") &&
    !normalized.startsWith("fe80:") &&
    !normalized.startsWith("fc") &&
    !normalized.startsWith("fd") &&
    !normalized.startsWith("ff") &&
    normalized !== "::" &&
    normalized !== "::1"
  );
}

function isPrivateIpv4(address: string): boolean {
  const parts = parseIpv4Segments(address);
  if (!parts) return false;
  const [first, second] = parts;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function isSpecialIpv4(address: string): boolean {
  const parts = parseIpv4Segments(address);
  if (!parts) return true;
  const [first, second, third, fourth] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    (first === 255 && second === 255 && third === 255 && fourth === 255)
  );
}

function isNetworkOrBroadcastIpv4Address(address: string, netmask: string): boolean {
  const addressParts = parseIpv4Segments(address);
  const netmaskParts = netmask ? parseIpv4Segments(netmask) : null;
  if (!addressParts) return true;
  if (!netmaskParts) {
    const last = addressParts[3];
    return last === 0 || last === 255;
  }
  const addressInt = ipv4SegmentsToInt(addressParts);
  const netmaskInt = ipv4SegmentsToInt(netmaskParts);
  const hostMask = (~netmaskInt) >>> 0;
  if (hostMask === 0) return false;
  const networkInt = addressInt & netmaskInt;
  const broadcastInt = (networkInt | hostMask) >>> 0;
  return addressInt === networkInt || addressInt === broadcastInt;
}

function isValidIpv4(address: string): boolean {
  return Boolean(parseIpv4Segments(address));
}

function parseIpv4Segments(address: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(address)) return null;
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function ipv4SegmentsToInt(parts: number[]): number {
  return ((parts[0] << 24) >>> 0 | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
