import process from "node:process";

const MINIMUM_NODE_VERSION = "20.0.0";

function parseVersion(input) {
  const normalized = String(input ?? "")
    .trim()
    .replace(/^v/i, "");
  const [major = "0", minor = "0", patch = "0"] = normalized.split(".");
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor, 10) || 0,
    Number.parseInt(patch, 10) || 0,
  ];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
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

const current = parseVersion(process.versions.node);
const minimum = parseVersion(MINIMUM_NODE_VERSION);

if (compareVersions(current, minimum) < 0) {
  const language = detectLanguage();
  console.error("");
  if (language === "zh-CN") {
    console.error("Hermes Link 需要 Node.js 20.0.0 或更新版本。");
    console.error(`当前使用的是 Node.js ${process.versions.node}。`);
    console.error("");
    console.error("为什么需要这样做：");
    console.error("- Hermes Link 与 hermes-agent 的 Node.js 20+ 要求保持一致。");
    console.error("- 如果继续在旧版 Node.js 上安装，后续配对、后台服务或本地数据库可能会失败。");
    console.error("");
    console.error("请先升级 Node.js，然后重新运行安装命令。");
  } else {
    console.error("Hermes Link needs Node.js 20.0.0 or newer.");
    console.error(`You are using Node.js ${process.versions.node}.`);
    console.error("");
    console.error("Why this is required:");
    console.error("- Hermes Link now matches hermes-agent's Node.js 20+ requirement.");
    console.error("- If installation continued on an older Node.js version, pairing, the background service, or the local database could fail later.");
    console.error("");
    console.error("Please update Node.js first, then run the install command again.");
  }
  console.error("");
  process.exit(1);
}
