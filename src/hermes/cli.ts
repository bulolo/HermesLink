import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface HermesCliResult {
  stdout: string;
  stderr: string;
}

export interface SessionDeleteResult {
  deleted: boolean;
  notFound: boolean;
}

export function resolveHermesBin(): string {
  return process.env.HERMES_BIN?.trim() || "hermes";
}

export function profileArgs(profileName: string | null | undefined): string[] {
  if (!profileName || profileName === "default") return [];
  return ["-p", profileName];
}

export async function deleteHermesSession(
  sessionId: string,
  profileName?: string | null,
): Promise<SessionDeleteResult> {
  const bin = resolveHermesBin();
  const args = [...profileArgs(profileName), "sessions", "delete", sessionId];
  try {
    const { stdout, stderr } = await execFileAsync(bin, args);
    return readSessionDeleteStatus(stdout, stderr);
  } catch (error) {
    const output = readExecErrorOutput(error);
    if (isSessionNotFoundOutput(output)) {
      return { deleted: false, notFound: true };
    }
    throw error;
  }
}

export async function renameHermesSession(
  sessionId: string,
  title: string,
  profileName?: string | null,
): Promise<void> {
  const bin = resolveHermesBin();
  const args = [...profileArgs(profileName), "sessions", "rename", sessionId, title];
  await execFileAsync(bin, args);
}

function readSessionDeleteStatus(stdout: string, stderr: string): SessionDeleteResult {
  const output = `${stdout}\n${stderr}`.toLowerCase();
  if (isSessionNotFoundOutput(output)) {
    return { deleted: false, notFound: true };
  }
  return { deleted: true, notFound: false };
}

function isSessionNotFoundOutput(output: string): boolean {
  return /not found|no such session|does not exist/iu.test(output);
}

export function readExecErrorOutput(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    return `${stdout}\n${stderr}`;
  }
  return "";
}
