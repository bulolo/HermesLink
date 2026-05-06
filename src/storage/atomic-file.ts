import { randomUUID } from "crypto";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "fs/promises";
import path from "path";

interface FileMetadata {
  uid: number;
  gid: number;
  mode: number;
}

export async function atomicWriteFilePreservingMetadata(
  filePath: string,
  value: string | Buffer,
  options: { mode?: number; directoryMode?: number; metadataSourcePath?: string; encoding?: BufferEncoding } = {},
): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  const directory = path.dirname(resolvedPath);
  await ensureDirectoryWithInheritedMetadata(directory, options.directoryMode ?? 0o700);

  const existingMetadata =
    (await readExistingFileMetadata(resolvedPath)) ??
    (options.metadataSourcePath
      ? await readExistingFileMetadata(path.resolve(options.metadataSourcePath))
      : null);
  const directoryMetadata = await readPathMetadata(directory);
  const metadata: FileMetadata = {
    uid: existingMetadata?.uid ?? directoryMetadata.uid,
    gid: existingMetadata?.gid ?? directoryMetadata.gid,
    mode: existingMetadata?.mode ?? options.mode ?? 0o600,
  };

  const tempPath = path.join(
    directory,
    `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(tempPath, "wx", metadata.mode);
    try {
      if (typeof value === "string") {
        await handle.writeFile(value, options.encoding ?? "utf8");
      } else {
        await handle.writeFile(value);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await applyMetadata(tempPath, metadata);
    await rename(tempPath, resolvedPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function inheritOwnerRecursively(targetPath: string, sourcePath: string): Promise<void> {
  if (process.platform === "win32") return;
  const source = await readPathMetadata(sourcePath);
  await applyOwnerRecursively(targetPath, source);
}

async function ensureDirectoryWithInheritedMetadata(directory: string, mode: number): Promise<void> {
  const { source, missing } = await findExistingAncestor(directory);
  await mkdir(directory, { recursive: true, mode });
  for (const missingDirectory of missing) {
    await applyMetadata(missingDirectory, { uid: source.uid, gid: source.gid, mode });
  }
}

async function findExistingAncestor(directory: string): Promise<{ source: FileMetadata; missing: string[] }> {
  const missing: string[] = [];
  let current = path.resolve(directory);
  while (true) {
    const currentStat = await stat(current).catch((error) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    if (currentStat) {
      if (!currentStat.isDirectory()) throw new Error(`${current} is not a directory`);
      return { source: metadataFromStats(currentStat), missing: missing.reverse() };
    }
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing parent directory for ${directory}`);
    current = parent;
  }
}

async function readExistingFileMetadata(filePath: string): Promise<FileMetadata | null> {
  const fileStat = await stat(filePath).catch((error) => {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  });
  if (!fileStat) return null;
  if (!fileStat.isFile()) throw new Error(`${filePath} is not a file`);
  return metadataFromStats(fileStat);
}

async function readPathMetadata(filePath: string): Promise<FileMetadata> {
  return metadataFromStats(await stat(filePath));
}

async function applyMetadata(filePath: string, metadata: FileMetadata): Promise<void> {
  await applyOwner(filePath, metadata);
  await chmod(filePath, metadata.mode);
}

async function applyOwnerRecursively(filePath: string, metadata: FileMetadata): Promise<void> {
  const current = await lstat(filePath);
  if (current.isSymbolicLink()) return;
  await applyOwner(filePath, metadata);
  if (!current.isDirectory()) return;
  const entries = await readdir(filePath, { withFileTypes: true });
  await Promise.all(entries.map((entry) => applyOwnerRecursively(path.join(filePath, entry.name), metadata)));
}

async function applyOwner(filePath: string, metadata: FileMetadata): Promise<void> {
  if (process.platform === "win32") return;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const currentGid = typeof process.getgid === "function" ? process.getgid() : undefined;
  if (metadata.uid === currentUid && metadata.gid === currentGid) return;
  try {
    await chown(filePath, metadata.uid, metadata.gid);
  } catch (error) {
    const current = await stat(filePath);
    if (current.uid !== metadata.uid || current.gid !== metadata.gid) throw error;
  }
}

function metadataFromStats(statsValue: { uid: number; gid: number; mode: number }): FileMetadata {
  return { uid: statsValue.uid, gid: statsValue.gid, mode: statsValue.mode & 0o777 };
}

export function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
