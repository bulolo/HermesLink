import os from "os";
import path from "path";
import { LINK_RUNTIME_DIR_NAME } from "../constants.js";

export interface RuntimePaths {
  homeDir: string;
  identityFile: string;
  configFile: string;
  stateFile: string;
  credentialsFile: string;
  databaseFile: string;
  conversationsDir: string;
  blobsDir: string;
  indexesDir: string;
  logsDir: string;
  runDir: string;
  pairingDir: string;
}

export function resolveRuntimeHome(): string {
  return process.env.HERMESLINK_HOME?.trim()
    ? path.resolve(process.env.HERMESLINK_HOME)
    : path.join(os.homedir(), LINK_RUNTIME_DIR_NAME);
}

export function resolveRuntimePaths(homeDir = resolveRuntimeHome()): RuntimePaths {
  return {
    homeDir,
    identityFile: path.join(homeDir, "identity.json"),
    configFile: path.join(homeDir, "config.json"),
    stateFile: path.join(homeDir, "state.json"),
    credentialsFile: path.join(homeDir, "credentials.json"),
    databaseFile: path.join(homeDir, "link.db"),
    conversationsDir: path.join(homeDir, "conversations"),
    blobsDir: path.join(homeDir, "blobs"),
    indexesDir: path.join(homeDir, "indexes"),
    logsDir: path.join(homeDir, "logs"),
    runDir: path.join(homeDir, "run"),
    pairingDir: path.join(homeDir, "pairing"),
  };
}
