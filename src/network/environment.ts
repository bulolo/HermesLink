import { existsSync, readFileSync } from "fs";
import os from "os";

export interface RuntimeEnvironment {
  kind: "native" | "wsl" | "container";
  lanAutoDiscoveryUsable: boolean;
  warning: string | null;
}

export function detectRuntimeEnvironment(env: NodeJS.ProcessEnv = process.env): RuntimeEnvironment {
  if (isWsl(env)) {
    return {
      kind: "wsl",
      lanAutoDiscoveryUsable: false,
      warning:
        "Detected WSL. The LAN IP found inside WSL is usually a private VM address and is not reachable from your phone. Use Relay or set `hermeslink config set lan-host <Windows LAN IP>`.",
    };
  }
  if (isContainer(env)) {
    return {
      kind: "container",
      lanAutoDiscoveryUsable: false,
      warning:
        "Detected a container environment. Container LAN IPs are usually not reachable from your phone. Use Relay or set `hermeslink config set lan-host <host LAN IP>`.",
    };
  }
  return { kind: "native", lanAutoDiscoveryUsable: true, warning: null };
}

function isWsl(env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true;
  }
  const release = os.release().toLowerCase();
  return release.includes("microsoft") || release.includes("wsl");
}

function isContainer(env: NodeJS.ProcessEnv): boolean {
  if (env.container || env.CONTAINER || env.KUBERNETES_SERVICE_HOST) {
    return true;
  }
  if (existsSync("/.dockerenv")) {
    return true;
  }
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8").toLowerCase();
    return /docker|containerd|kubepods|libpod|podman/u.test(cgroup);
  } catch {
    return false;
  }
}
