import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

export const LINK_COMMAND = "hermeslink";
export const LINK_VERSION = _pkg.version;
export const LINK_DEFAULT_PORT = 52379;
export const LINK_RUNTIME_DIR_NAME = ".hermeslink";

export const DEFAULT_LOG_FILE = "hermeslink.log";
export const DAEMON_LOG_FILE = "daemon.log";
export const GATEWAY_LOG_FILE = "hermes-gateway.log";

export const MIN_API_SERVER_VERSION = "0.4.0";
export const DEFAULT_HERMES_API_SERVER_HOST = "127.0.0.1";
export const DEFAULT_HERMES_API_SERVER_PORT = 8642;
export const PROFILE_API_SERVER_PORT_START = DEFAULT_HERMES_API_SERVER_PORT + 1;
export const PROFILE_API_SERVER_PORT_END = DEFAULT_HERMES_API_SERVER_PORT + 999;
