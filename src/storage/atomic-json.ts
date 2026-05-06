import { readFile } from "fs/promises";
import { atomicWriteFilePreservingMetadata, isNodeError } from "./atomic-file.js";

export async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

export async function writeJsonFile(filePath: string, value: unknown, mode = 0o600): Promise<void> {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await atomicWriteFilePreservingMetadata(filePath, payload, { mode });
}
