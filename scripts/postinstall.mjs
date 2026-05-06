import process from "node:process";

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function shouldPrintInstallHint() {
  if (isTruthy(process.env.HERMESLINK_POSTINSTALL_QUIET)) return false;
  if (isTruthy(process.env.CI)) return false;
  return process.env.npm_config_global === "true";
}

function detectLanguage() {
  const candidates = [
    process.env.HERMESLINK_LANG,
    process.env.HERMESLINK_LANGUAGE,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    process.env.LANGUAGE?.split(":")[0],
    Intl.DateTimeFormat().resolvedOptions().locale,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").trim().replace("_", "-").toLowerCase();
    if (normalized.startsWith("zh")) return "zh-CN";
    if (normalized.startsWith("en")) return "en";
  }
  return "en";
}

async function main() {
  if (!shouldPrintInstallHint()) return;
  const language = detectLanguage();
  console.log("");
  if (language === "zh-CN") {
    console.log("Hermes Link 已安装。");
    console.log("运行 `hermeslink pair`，把这台电脑连接到 App。");
  } else {
    console.log("Hermes Link installed.");
    console.log("Run `hermeslink pair` to connect this computer with the App.");
  }
  console.log("");
}

main().catch(() => {});
