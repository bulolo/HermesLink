import { generateKeyPairSync, randomUUID, sign } from "crypto";
import { chmod, mkdir } from "fs/promises";
import { z } from "zod";
import { resolveRuntimePaths, type RuntimePaths } from "../runtime/paths.js";
import { readJsonFile, writeJsonFile } from "../storage/atomic-json.js";

const linkIdentitySchema = z.object({
  install_id: z.string().min(1),
  link_id: z.string().min(1).nullable().optional(),
  public_key_pem: z.string().min(1),
  private_key_pem: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export type LinkIdentity = z.infer<typeof linkIdentitySchema>;

export interface IdentityStatus {
  installId: string;
  linkId: string | null;
  hasPrivateKey: boolean;
  publicKeyPem: string;
}

export async function loadIdentity(paths: RuntimePaths = resolveRuntimePaths()): Promise<LinkIdentity | null> {
  const value = await readJsonFile(paths.identityFile);
  if (value === null) {
    return null;
  }
  return linkIdentitySchema.parse(value);
}

export async function ensureIdentity(paths: RuntimePaths = resolveRuntimePaths()): Promise<LinkIdentity> {
  const existing = await loadIdentity(paths);
  if (existing) {
    return existing;
  }
  await mkdir(paths.homeDir, { recursive: true, mode: 0o700 });
  await chmod(paths.homeDir, 0o700).catch(() => undefined);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const now = new Date().toISOString();
  const identity: LinkIdentity = {
    install_id: `install_${randomUUID().replaceAll("-", "")}`,
    link_id: null,
    public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    created_at: now,
    updated_at: now,
  };
  await writeJsonFile(paths.identityFile, identity);
  return identity;
}

export async function saveAssignedLinkId(
  linkId: string,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<LinkIdentity> {
  const identity = await ensureIdentity(paths);
  const next: LinkIdentity = {
    ...identity,
    link_id: linkId,
    updated_at: new Date().toISOString(),
  };
  await writeJsonFile(paths.identityFile, next);
  return next;
}

export function signRelayNonce(identity: LinkIdentity, nonce: string): string {
  return signIdentityPayload(identity, nonce);
}

function signIdentityPayload(identity: LinkIdentity, payload: string): string {
  const signature = sign(null, Buffer.from(payload, "utf8"), identity.private_key_pem);
  return signature.toString("base64url");
}

export function getIdentityStatus(identity: LinkIdentity): IdentityStatus {
  return {
    installId: identity.install_id,
    linkId: identity.link_id ?? null,
    hasPrivateKey: identity.private_key_pem.trim().length > 0,
    publicKeyPem: identity.public_key_pem,
  };
}
