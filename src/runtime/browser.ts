import { spawn } from "child_process";

export async function openSystemBrowser(url: string): Promise<boolean> {
  const platform = process.platform;
  if (platform === "win32") {
    return spawnDetached("cmd", ["/c", "start", "", url]);
  }
  if (platform === "darwin") {
    return spawnDetached("open", [url]);
  }
  return spawnDetached("xdg-open", [url]);
}

async function spawnDetached(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.once("error", () => settle(false));
      child.once("spawn", () => {
        child.unref();
        settle(true);
      });
    } catch {
      settle(false);
    }
  });
}
