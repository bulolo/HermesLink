import { randomBytes } from "crypto";
import net from "net";
import { readFile, readdir } from "fs/promises";
import os from "os";
import path from "path";
import YAML from "yaml";
import { atomicWriteFilePreservingMetadata, isNodeError } from "../storage/atomic-file.js";
import {
  DEFAULT_HERMES_API_SERVER_HOST,
  DEFAULT_HERMES_API_SERVER_PORT,
  PROFILE_API_SERVER_PORT_START,
  PROFILE_API_SERVER_PORT_END,
  MIN_API_SERVER_VERSION,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Hint strings (Chinese)
// ---------------------------------------------------------------------------

export const MODEL_CONFIG_RESTART_HINT =
  "模型配置已保存。建议重载 Hermes Gateway，正在运行中的 Run 不会被中断，新的 Run 会读取最新配置。";
export const MODEL_DEFAULTS_APPLIED_HINT =
  "默认模型设置已保存。新的 Run 会直接读取最新配置，无需重载 Hermes Gateway。";
export const PROFILE_PERMISSIONS_RESTART_HINT =
  "权限配置已保存。后续以该 Profile 发起的新 Run 会读取最新配置；如果该 Profile 的 Gateway 已经在运行，需要重载对应 Gateway。";
export const PROFILE_TOOL_CONFIG_RESTART_HINT =
  "工具后端配置已保存。后续以该 Profile 发起的新 Run 会读取最新配置；如果该 Profile 的 Gateway 已经在运行，需要重载对应 Gateway。";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REASONING_EFFORTS: string[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export interface ProfilePermissionToolset {
  key: string;
  label: string;
  description: string;
  risk: "low" | "medium" | "high";
}

export const PROFILE_PERMISSION_TOOLSETS: ProfilePermissionToolset[] = [
  {
    key: "web",
    label: "Web 搜索",
    description: "联网搜索与网页内容提取",
    risk: "low",
  },
  {
    key: "vision",
    label: "视觉理解",
    description: "读取图片内容并参与推理",
    risk: "low",
  },
  {
    key: "image_gen",
    label: "图片生成",
    description: "调用图片生成后端",
    risk: "low",
  },
  {
    key: "browser",
    label: "浏览器自动化",
    description: "打开网页、点击、输入和读取页面",
    risk: "medium",
  },
  {
    key: "skills",
    label: "Skills",
    description: "读取和管理 Hermes skills",
    risk: "medium",
  },
  {
    key: "memory",
    label: "Memory",
    description: "读取和写入长期记忆",
    risk: "medium",
  },
  {
    key: "session_search",
    label: "会话搜索",
    description: "搜索历史会话与摘要",
    risk: "medium",
  },
  {
    key: "todo",
    label: "任务规划",
    description: "维护会话内任务列表",
    risk: "medium",
  },
  {
    key: "delegation",
    label: "子任务代理",
    description: "创建独立上下文的子 Agent",
    risk: "medium",
  },
  {
    key: "terminal",
    label: "终端执行",
    description: "执行 shell 命令和管理进程",
    risk: "high",
  },
  {
    key: "file",
    label: "文件读写",
    description: "读取、搜索、写入和 patch 文件",
    risk: "high",
  },
  {
    key: "code_execution",
    label: "代码执行",
    description: "在工具沙箱中执行代码片段",
    risk: "high",
  },
  {
    key: "cronjob",
    label: "定时任务",
    description: "创建、更新、暂停和运行 cron jobs",
    risk: "high",
  },
  {
    key: "messaging",
    label: "跨平台消息",
    description: "向 Telegram、Discord、Slack 等平台发消息",
    risk: "high",
  },
  {
    key: "homeassistant",
    label: "智能家居",
    description: "读取和控制 Home Assistant 设备",
    risk: "high",
  },
  {
    key: "stt",
    label: "语音转写 (STT)",
    description: "把用户语音消息转成文本输入",
    risk: "medium",
  },
  {
    key: "tts",
    label: "语音合成 (TTS)",
    description: "生成语音音频",
    risk: "medium",
  },
  {
    key: "moa",
    label: "Mixture of Agents",
    description: "调用多 Agent 推理工具",
    risk: "medium",
  },
  {
    key: "rl",
    label: "RL 训练",
    description: "管理强化学习训练任务",
    risk: "high",
  },
];

export const PROFILE_PERMISSION_TOOLSET_KEYS: Set<string> = new Set(
  PROFILE_PERMISSION_TOOLSETS.map((toolset) => toolset.key),
);

export const API_SERVER_PROFILE_TOOLSET_KEYS: Set<string> = new Set(
  PROFILE_PERMISSION_TOOLSETS.filter((toolset) => toolset.key !== "stt").map(
    (toolset) => toolset.key,
  ),
);

export const API_SERVER_DEFAULT_ENABLED_TOOLSETS: Set<string> = new Set([
  "web",
  "browser",
  "terminal",
  "file",
  "code_execution",
  "vision",
  "image_gen",
  "skills",
  "todo",
  "memory",
  "session_search",
  "delegation",
  "cronjob",
]);

export const PLATFORM_DEFAULT_TOOLSETS: Set<string> = new Set([
  "hermes-api-server",
  "hermes-bluebubbles",
  "hermes-cli",
  "hermes-dingtalk",
  "hermes-discord",
  "hermes-email",
  "hermes-feishu",
  "hermes-gateway",
  "hermes-homeassistant",
  "hermes-matrix",
  "hermes-mattermost",
  "hermes-qqbot",
  "hermes-signal",
  "hermes-slack",
  "hermes-telegram",
  "hermes-webhook",
  "hermes-wecom",
  "hermes-wecom-callback",
  "hermes-weixin",
  "hermes-whatsapp",
]);

export const TERMINAL_BACKENDS: Set<string> = new Set([
  "local",
  "ssh",
  "docker",
  "singularity",
  "modal",
  "daytona",
]);

// ---------------------------------------------------------------------------
// Port assignment queue (module-level lock)
// ---------------------------------------------------------------------------

let profileApiServerPortAssignmentQueue: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function resolveHermesProfileDir(profileName = "default"): string {
  const hermesHome = process.env.HERMES_HOME?.trim();
  if (hermesHome) {
    const resolvedHome = path.resolve(hermesHome);
    if (profileName === "default") {
      return resolvedHome;
    }
    return path.join(
      resolveDefaultHermesRoot(resolvedHome),
      "profiles",
      profileName,
    );
  }
  if (profileName === "default") {
    return path.join(os.homedir(), ".hermes");
  }
  return path.join(os.homedir(), ".hermes", "profiles", profileName);
}

export function resolveHermesProfilesDir(): string {
  const hermesHome = process.env.HERMES_HOME?.trim();
  if (hermesHome) {
    return path.join(
      resolveDefaultHermesRoot(path.resolve(hermesHome)),
      "profiles",
    );
  }
  return path.join(os.homedir(), ".hermes", "profiles");
}

export function resolveHermesConfigPath(profileName = "default"): string {
  return path.join(resolveHermesProfileDir(profileName), "config.yaml");
}

// ---------------------------------------------------------------------------
// Public read/write functions
// ---------------------------------------------------------------------------

export async function readHermesSessionsDir(
  profileName = "default",
  configPath = resolveHermesConfigPath(profileName),
): Promise<{ configPath: string; sessionsDir: string; configured: boolean }> {
  const profileDir = resolveHermesProfileDir(profileName);
  const { config } = await readHermesConfigDocument(configPath);
  const configuredValue = readStr(config.sessions_dir);
  return {
    configPath,
    sessionsDir: configuredValue
      ? resolveHermesConfiguredPath(configuredValue, path.dirname(configPath))
      : path.join(profileDir, "sessions"),
    configured: Boolean(configuredValue),
  };
}

export async function readHermesApiServerConfig(
  profileName = "default",
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  const existingRaw = await readFile(configPath, "utf8").catch((error) => {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (!existingRaw) {
    return applyEnvOverrides(
      {},
      await readHermesApiServerEnvOverrides(profileName),
      false,
    );
  }
  const config = toRecord(YAML.parse(existingRaw));
  const platforms = toRecord(config.platforms);
  const apiServer = toRecord(platforms.api_server);
  return applyEnvOverrides(
    readApiServerConfig(apiServer, true),
    await readHermesApiServerEnvOverrides(profileName),
    true,
  );
}

export async function readHermesModelConfig(
  profileName = "default",
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  const existingRaw = await readFile(configPath, "utf8").catch((error) => {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  const config = existingRaw ? toRecord(YAML.parse(existingRaw)) : {};
  const modelConfig = readModelConfig(config.model);
  const envModel = process.env.HERMES_MODEL?.trim();
  return {
    ...modelConfig,
    model: envModel || modelConfig.model,
    reasoningEffort: readProfileReasoningEffort(config) ?? undefined,
  };
}

export async function listHermesModelConfigs(
  profileName = "default",
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  const { config } = await readHermesConfigDocument(configPath);
  const env = await readHermesEnvFile(profileName);
  const defaultModel = readModelConfig(config.model).model ?? null;
  const defaultReasoningEffort = readProfileReasoningEffort(config);
  const models = readManagedModelConfigs(
    config,
    env,
    defaultModel,
    defaultReasoningEffort,
  );
  const compressionModelId = readAuxiliaryCompressionModelId(config);
  return {
    ok: true,
    configPath,
    defaultModel,
    defaultReasoningEffort,
    compressionModelId,
    compressionModel: resolveCompressionModel(config, models),
    models,
  };
}

export async function saveHermesModelConfig(
  input: Record<string, unknown>,
  profileName = "default",
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  const normalized = normalizeModelConfigInput(input);
  const shouldUpdateReasoningEffort = input.reasoningEffort !== undefined;
  const { document, config, existingRaw } =
    await readHermesConfigDocument(configPath);
  const customProviders = ensureCustomProvidersList(config);
  const originalModelId =
    (input.originalModelId as string | undefined)?.trim() || normalized.id;
  const index = findCustomProviderIndex(customProviders, originalModelId);
  const entry: Record<string, unknown> =
    index >= 0 ? toRecord(customProviders[index]) : {};

  const existingKeyEnv =
    readStr(entry.key_env) ?? parseEnvReference(readStr(entry.api_key));
  const keyEnv =
    normalized.keyEnv ??
    existingKeyEnv ??
    (normalized.apiKey
      ? buildApiKeyEnvName(normalized.providerName, normalized.id)
      : undefined);

  if (normalized.apiKey && keyEnv) {
    await writeHermesEnvValue(profileName, keyEnv, normalized.apiKey);
  }

  entry.name = normalized.providerName;
  entry.provider_key = normalized.provider;
  entry.base_url = normalized.baseUrl;
  entry.model = normalized.id;
  if (normalized.apiMode) {
    entry.api_mode = normalized.apiMode;
  } else {
    delete entry.api_mode;
  }
  if (normalized.contextLength) {
    entry.context_length = normalized.contextLength;
  } else {
    delete entry.context_length;
  }
  if (keyEnv) {
    entry.key_env = keyEnv;
    delete entry.api_key;
  } else {
    delete entry.key_env;
  }

  updateEntryModels(entry, originalModelId, normalized.id);

  if (shouldUpdateReasoningEffort) {
    writeEntryModelReasoningEffort(
      entry,
      normalized.id,
      normalized.reasoningEffort,
    );
  }

  if (index >= 0) {
    customProviders[index] = entry;
  } else {
    customProviders.push(entry);
  }

  const modelConfig = ensureRecord(config, "model");
  const currentDefaultConfig = readModelConfig(modelConfig);
  const currentDefault = currentDefaultConfig.model;
  const currentDefaultReasoningEffort = readProfileReasoningEffort(config);

  if (
    normalized.setDefault ||
    !currentDefault ||
    currentDefault === originalModelId
  ) {
    if (
      normalized.setDefault &&
      currentDefault &&
      currentDefault !== normalized.id &&
      currentDefault !== originalModelId
    ) {
      retainModelDefaultAsCustomProvider(customProviders, {
        ...currentDefaultConfig,
        ...(currentDefaultReasoningEffort
          ? { reasoningEffort: currentDefaultReasoningEffort }
          : {}),
      });
    }
    const defaultKeyEnv =
      keyEnv ??
      (currentDefault === originalModelId
        ? currentDefaultConfig.keyEnv
        : undefined);
    const defaultApiKey =
      normalized.apiKey ??
      (!defaultKeyEnv && currentDefault === originalModelId
        ? currentDefaultConfig.apiKey
        : undefined);
    writeDefaultModelConfig(modelConfig, {
      ...normalized,
      apiKey: defaultApiKey,
      keyEnv: defaultKeyEnv,
    });
    if (shouldUpdateReasoningEffort && normalized.reasoningEffort) {
      writeProfileReasoningEffort(config, normalized.reasoningEffort);
    }
  }

  const backupPath = await writeHermesConfigDocument({
    configPath,
    document,
    config,
    existingRaw,
  });
  const listed = await listHermesModelConfigs(profileName, configPath);
  const models = listed.models as Array<Record<string, unknown>>;
  const savedModel = models.find((model) => model.id === normalized.id);
  if (!savedModel) {
    throw new Error("saved model is missing from config");
  }
  return {
    ...listed,
    model: savedModel,
    backupPath,
    requiresGatewayReload: true,
    restartHint: MODEL_CONFIG_RESTART_HINT,
  };
}

export async function deleteHermesModelConfig(
  modelId: string,
  profileName = "default",
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  const id = modelId.trim();
  if (!id) {
    throw new Error("model id is required");
  }
  const { document, config, existingRaw } =
    await readHermesConfigDocument(configPath);
  const env = await readHermesEnvFile(profileName);
  const existingModels = readManagedModelConfigs(
    config,
    env,
    readModelConfig(config.model).model ?? null,
    readProfileReasoningEffort(config),
  );
  if (!existingModels.some((model) => model.id === id)) {
    throw new Error(`model "${id}" is not configured`);
  }
  if (existingModels.length <= 1) {
    throw new Error(
      "至少需要保留一个模型，避免 Hermes Agent 没有可用默认模型。",
    );
  }
  const customProviders = ensureCustomProvidersList(config);
  const nextProviders = customProviders
    .map((entry) => removeModelFromCustomProvider(toRecord(entry), id))
    .filter((entry) => entry !== null);
  config.custom_providers = nextProviders;

  const modelConfig = ensureRecord(config, "model");
  const currentDefault = readModelConfig(modelConfig).model;
  if (currentDefault === id) {
    const nextDefault = readManagedModelConfigs(
      config,
      env,
      null,
      readProfileReasoningEffort(config),
    )[0];
    if (nextDefault) {
      writeDefaultModelConfig(modelConfig, {
        id: nextDefault.id,
        provider: nextDefault.provider,
        baseUrl: nextDefault.baseUrl,
        apiMode: nextDefault.apiMode,
        contextLength: nextDefault.contextLength,
        keyEnv: nextDefault.keyEnv,
      });
      if (nextDefault.reasoningEffort) {
        writeProfileReasoningEffort(config, nextDefault.reasoningEffort);
      }
    } else {
      delete modelConfig.default;
      delete modelConfig.model;
      delete modelConfig.name;
      delete modelConfig.provider;
      delete modelConfig.base_url;
      delete modelConfig.api_key;
      delete modelConfig.key_env;
      delete modelConfig.api_mode;
      delete modelConfig.context_length;
    }
  }

  const backupPath = await writeHermesConfigDocument({
    configPath,
    document,
    config,
    existingRaw,
  });
  const listed = await listHermesModelConfigs(profileName, configPath);
  return {
    ...listed,
    backupPath,
    requiresGatewayReload: true,
    restartHint: MODEL_CONFIG_RESTART_HINT,
  };
}

export async function saveHermesModelDefaults(
  input: { taskModelId?: string; compressionModelId?: string },
  profileName = "default",
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  const taskModelId = input.taskModelId?.trim();
  const compressionModelId = input.compressionModelId?.trim();
  if (!taskModelId && !compressionModelId) {
    throw new Error("taskModelId or compressionModelId is required");
  }
  const { document, config, existingRaw } =
    await readHermesConfigDocument(configPath);
  const env = await readHermesEnvFile(profileName);

  if (taskModelId) {
    const models = readManagedModelConfigs(
      config,
      env,
      readModelConfig(config.model).model ?? null,
      readProfileReasoningEffort(config),
    );
    const selected = findManagedModelById(models, taskModelId);
    if (!selected) {
      throw new Error(`model "${taskModelId}" is not configured`);
    }
    const customProviders = ensureCustomProvidersList(config);
    const modelConfig = ensureRecord(config, "model");
    const currentDefaultConfig = readModelConfig(modelConfig);
    const currentDefaultReasoningEffort = readProfileReasoningEffort(config);
    if (
      currentDefaultConfig.model &&
      currentDefaultConfig.model !== selected.id
    ) {
      retainModelDefaultAsCustomProvider(customProviders, {
        ...currentDefaultConfig,
        ...(currentDefaultReasoningEffort
          ? { reasoningEffort: currentDefaultReasoningEffort }
          : {}),
      });
    }
    writeDefaultModelConfig(modelConfig, {
      id: selected.id,
      provider: selected.provider,
      baseUrl: selected.baseUrl,
      apiMode: selected.apiMode,
      contextLength: selected.contextLength,
      keyEnv: selected.keyEnv,
    });
    if (selected.reasoningEffort) {
      writeProfileReasoningEffort(config, selected.reasoningEffort);
    }
  }

  if (compressionModelId) {
    const models = readManagedModelConfigs(
      config,
      env,
      readModelConfig(config.model).model ?? null,
      readProfileReasoningEffort(config),
    );
    const selected = findManagedModelById(models, compressionModelId);
    if (!selected) {
      throw new Error(`model "${compressionModelId}" is not configured`);
    }
    writeAuxiliaryCompressionModelConfig(config, selected, env);
  }

  const backupPath = await writeHermesConfigDocument({
    configPath,
    document,
    config,
    existingRaw,
  });
  const listed = await listHermesModelConfigs(profileName, configPath);
  return {
    ...listed,
    backupPath,
    requiresGatewayReload: false,
    restartHint: MODEL_DEFAULTS_APPLIED_HINT,
  };
}

export async function readHermesProfilePermissions(
  profileName = "default",
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  const { config } = await readHermesConfigDocument(configPath);
  const env = await readHermesEnvFile(profileName);
  return profilePermissionsFromConfig(profileName, configPath, config, env);
}

export async function saveHermesProfilePermissions(
  profileName: string,
  input: Record<string, unknown>,
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  const { document, config, existingRaw } =
    await readHermesConfigDocument(configPath);

  const inputApprovals = input.approvals as Record<string, unknown> | undefined;
  if (inputApprovals) {
    const approvals = ensureRecord(config, "approvals");
    if (inputApprovals.mode !== undefined) {
      approvals.mode = normalizeApprovalMode(inputApprovals.mode as string);
    }
    if (inputApprovals.timeout !== undefined) {
      approvals.timeout = normalizePositiveInteger(
        inputApprovals.timeout as number,
        "approvals.timeout",
      );
    }
    if (inputApprovals.cronMode !== undefined) {
      approvals.cron_mode = normalizeCronApprovalMode(
        inputApprovals.cronMode as string,
      );
    }
  }

  const inputTerminal = input.terminal as Record<string, unknown> | undefined;
  if (inputTerminal) {
    const terminal = ensureRecord(config, "terminal");
    if (inputTerminal.backend !== undefined) {
      terminal.backend = normalizeTerminalBackend(
        inputTerminal.backend as string,
      );
    }
    if (inputTerminal.cwd !== undefined) {
      terminal.cwd = normalizeNonEmptyString(
        inputTerminal.cwd as string,
        "terminal.cwd",
      );
    }
    if (inputTerminal.containerCpu !== undefined) {
      terminal.container_cpu = normalizePositiveInteger(
        inputTerminal.containerCpu as number,
        "terminal.container_cpu",
      );
    }
    if (inputTerminal.containerMemory !== undefined) {
      terminal.container_memory = normalizePositiveInteger(
        inputTerminal.containerMemory as number,
        "terminal.container_memory",
      );
    }
    if (inputTerminal.containerDisk !== undefined) {
      terminal.container_disk = normalizePositiveInteger(
        inputTerminal.containerDisk as number,
        "terminal.container_disk",
      );
    }
    if (inputTerminal.containerPersistent !== undefined) {
      terminal.container_persistent = inputTerminal.containerPersistent;
    }
  }

  const inputToolsets = input.toolsets as Record<string, unknown> | undefined;
  if (inputToolsets) {
    const env = await readHermesEnvFile(profileName);
    const currentPermissions = profilePermissionsFromConfig(
      profileName,
      configPath,
      config,
      env,
    );
    const platformToolsets = ensureRecord(config, "platform_toolsets");
    const existing = readStringList(platformToolsets.api_server);
    const currentToolsets = currentPermissions.toolsets as {
      items: Array<{ key: string; enabled: boolean }>;
    };
    const enabled = (
      (inputToolsets.enabledToolsets as string[] | undefined) ??
      currentToolsets.items
        .filter((toolset) => toolset.enabled)
        .map((toolset) => toolset.key)
    ).map((toolset) => normalizeToolsetKey(toolset));

    const preserved = existing.filter(
      (entry) =>
        !PROFILE_PERMISSION_TOOLSET_KEYS.has(entry) &&
        !PLATFORM_DEFAULT_TOOLSETS.has(entry) &&
        entry !== "no_mcp",
    );

    const next = [
      ...PROFILE_PERMISSION_TOOLSETS.filter(
        (toolset) => toolset.key !== "stt" && enabled.includes(toolset.key),
      ).map((toolset) => toolset.key),
      ...preserved,
    ];

    const stt = ensureRecord(config, "stt");
    stt.enabled = enabled.includes("stt");

    const mcpEnabled =
      (inputToolsets.mcpEnabled as boolean | undefined) ??
      (currentPermissions.toolsets as { mcpEnabled: boolean }).mcpEnabled;
    if (!mcpEnabled) {
      next.push("no_mcp");
    }
    platformToolsets.api_server = next;
  }

  const backupPath = await writeHermesConfigDocument({
    configPath,
    document,
    config,
    existingRaw,
  });
  return {
    ...(await readHermesProfilePermissions(profileName, configPath)),
    backupPath,
    requiresGatewayReload: true,
    restartHint: PROFILE_PERMISSIONS_RESTART_HINT,
  };
}

export async function addHermesCommandAllowlistEntry(
  profileName: string,
  entry: string,
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  const normalizedEntry = entry.trim();
  if (!normalizedEntry) {
    throw new Error("command_allowlist entry must be non-empty");
  }
  const { document, config, existingRaw } =
    await readHermesConfigDocument(configPath);
  const current = readStringList(config.command_allowlist);
  if (current.includes(normalizedEntry)) {
    return {
      profileName,
      configPath,
      commandAllowlist: current,
      entry: normalizedEntry,
      changed: false,
      backupPath: null,
      requiresGatewayReload: false,
      restartHint: PROFILE_PERMISSIONS_RESTART_HINT,
    };
  }
  config.command_allowlist = [...current, normalizedEntry];
  const backupPath = await writeHermesConfigDocument({
    configPath,
    document,
    config,
    existingRaw,
  });
  return {
    profileName,
    configPath,
    commandAllowlist: readStringList(config.command_allowlist),
    entry: normalizedEntry,
    changed: true,
    backupPath,
    requiresGatewayReload: true,
    restartHint: PROFILE_PERMISSIONS_RESTART_HINT,
  };
}

export async function readHermesProfileToolConfig(
  profileName: string,
  toolKey: string,
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  const normalizedToolKey = normalizeProfileToolConfigKey(toolKey);
  const { config } = await readHermesConfigDocument(configPath);
  const env = await readHermesEnvFile(profileName);
  return profileToolConfigFromSources(
    profileName,
    configPath,
    normalizedToolKey,
    config,
    env,
  );
}

export async function saveHermesProfileToolConfig(
  profileName: string,
  toolKey: string,
  input: { values: Record<string, unknown> },
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  const normalizedToolKey = normalizeProfileToolConfigKey(toolKey);
  const { document, config, existingRaw } =
    await readHermesConfigDocument(configPath);
  let configTouched = false;

  switch (normalizedToolKey) {
    case "web":
      configTouched = applyWebToolConfig(config, input.values);
      await writeToolConfigEnvValues(profileName, input.values, [
        "FIRECRAWL_API_KEY",
        "FIRECRAWL_API_URL",
        "TAVILY_API_KEY",
        "EXA_API_KEY",
        "PARALLEL_API_KEY",
      ]);
      break;
    case "image_gen":
      configTouched = applyImageGenToolConfig(config, input.values);
      await writeToolConfigEnvValues(profileName, input.values, [
        "FAL_KEY",
        "OPENAI_API_KEY",
        "XAI_API_KEY",
      ]);
      break;
    case "stt":
      configTouched = applySttToolConfig(
        config,
        input.values,
        await readHermesEnvFile(profileName),
      );
      await writeToolConfigEnvValues(profileName, input.values, [
        "GROQ_API_KEY",
        "VOICE_TOOLS_OPENAI_KEY",
        "OPENAI_API_KEY",
        "MISTRAL_API_KEY",
        "XAI_API_KEY",
        "HERMES_LOCAL_STT_COMMAND",
        "HERMES_LOCAL_STT_LANGUAGE",
        "STT_GROQ_MODEL",
        "STT_OPENAI_MODEL",
        "STT_MISTRAL_MODEL",
        "STT_OPENAI_BASE_URL",
        "GROQ_BASE_URL",
        "XAI_STT_BASE_URL",
      ]);
      break;
    case "tts":
      configTouched = applyTtsToolConfig(config, input.values);
      await writeToolConfigEnvValues(profileName, input.values, [
        "VOICE_TOOLS_OPENAI_KEY",
        "OPENAI_API_KEY",
        "ELEVENLABS_API_KEY",
        "MINIMAX_API_KEY",
        "MISTRAL_API_KEY",
        "GEMINI_API_KEY",
        "XAI_API_KEY",
      ]);
      break;
    case "messaging":
      await writeToolConfigEnvValues(profileName, input.values, [
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_ALLOWED_USERS",
        "TELEGRAM_HOME_CHANNEL",
        "DISCORD_BOT_TOKEN",
        "DISCORD_ALLOWED_USERS",
        "DISCORD_HOME_CHANNEL",
        "SLACK_BOT_TOKEN",
        "SLACK_APP_TOKEN",
        "SLACK_ALLOWED_USERS",
        "SLACK_HOME_CHANNEL",
      ]);
      break;
    case "homeassistant":
      await writeToolConfigEnvValues(profileName, input.values, [
        "HASS_URL",
        "HASS_TOKEN",
      ]);
      break;
    case "rl":
      await writeToolConfigEnvValues(profileName, input.values, [
        "TINKER_API_KEY",
        "WANDB_API_KEY",
        "WANDB_ENTITY",
      ]);
      break;
  }

  const backupPath = configTouched
    ? await writeHermesConfigDocument({
        configPath,
        document,
        config,
        existingRaw,
      })
    : null;

  return {
    ...(await readHermesProfileToolConfig(
      profileName,
      normalizedToolKey,
      configPath,
    )),
    backupPath,
    requiresGatewayReload: true,
    restartHint: PROFILE_TOOL_CONFIG_RESTART_HINT,
  };
}

export async function ensureHermesApiServerKey(
  profileName = "default",
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  return ensureHermesApiServerConfig(profileName, configPath);
}

export async function ensureHermesApiServerConfig(
  profileName = "default",
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  if (profileName !== "default") {
    return withProfileApiServerPortAssignmentLock(() =>
      ensureHermesApiServerConfigUnlocked(profileName, configPath),
    );
  }
  return ensureHermesApiServerConfigUnlocked(profileName, configPath);
}

export function isValidProfileName(value: unknown): boolean {
  return (
    typeof value === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(value)
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function ensureHermesApiServerConfigUnlocked(
  profileName = "default",
  configPath = resolveHermesConfigPath(profileName),
): Promise<Record<string, unknown>> {
  const existingRaw = await readFile(configPath, "utf8").catch((error) => {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  });

  const document = existingRaw
    ? YAML.parseDocument(existingRaw)
    : new YAML.Document({});
  const config = toRecord(document.toJSON());
  const platforms = ensureRecord(config, "platforms");
  const apiServer = ensureRecord(platforms, "api_server");
  const extra = ensureRecord(apiServer, "extra");
  const configOnly = readApiServerConfig(apiServer);
  const envOverrides = await readHermesApiServerEnvOverrides(profileName);
  const before = applyEnvOverrides(configOnly, envOverrides, false);
  const beforeKey = typeof before.key === "string" && before.key.trim() ? before.key : null;
  const beforeEnabled = before.enabled === true;
  const beforeHost = typeof before.host === "string" && before.host.trim() ? before.host : null;
  const beforePort =
    typeof before.port === "number" && Number.isFinite(before.port)
      ? before.port
      : null;

  let changed = false;
  let enabledAdded = false;
  let hostAdded = false;
  let portAdded = false;
  let assignedPort: number | null = null;

  if (!beforeEnabled) {
    apiServer.enabled = true;
    enabledAdded = true;
    changed = true;
  }
  if (!beforeHost) {
    extra.host = DEFAULT_HERMES_API_SERVER_HOST;
    hostAdded = true;
    changed = true;
  }
  if (shouldAssignDedicatedProfileApiServerPort(profileName, configOnly.port)) {
    assignedPort = await nextProfileApiServerPort(profileName);
    extra.port = assignedPort;
    portAdded = true;
    changed = true;
  } else if (!beforePort) {
    assignedPort = DEFAULT_HERMES_API_SERVER_PORT;
    extra.port = assignedPort;
    portAdded = true;
    changed = true;
  }
  if (!beforeKey) {
    extra.key = randomBytes(32).toString("base64url");
    changed = true;
  }

  if (!changed) {
    return {
      configPath,
      apiServer: applyEnvOverrides(
        readApiServerConfig(apiServer, true),
        envOverrides,
        true,
      ),
      changed: false,
      keyAdded: false,
      enabledAdded: false,
      hostAdded: false,
      portAdded: false,
      backupPath: null,
      notice: null,
    };
  }

  const backupPath = existingRaw ? `${configPath}.bak.${Date.now()}` : null;
  if (backupPath && existingRaw !== null) {
    await atomicWriteFilePreservingMetadata(backupPath, existingRaw, {
      metadataSourcePath: configPath,
    });
  }
  document.contents = document.createNode(config);
  await atomicWriteFilePreservingMetadata(configPath, document.toString());

  return {
    configPath,
    apiServer: applyEnvOverrides(
      readApiServerConfig(apiServer, true),
      envOverrides,
      true,
    ),
    changed: true,
    keyAdded: !beforeKey,
    enabledAdded,
    hostAdded,
    portAdded,
    backupPath,
    notice: buildNotice({
      keyAdded: !beforeKey,
      enabledAdded,
      hostAdded,
      portAdded,
      port: assignedPort ?? beforePort ?? undefined,
    }),
  };
}

async function readHermesConfigDocument(configPath: string): Promise<{
  document: YAML.Document;
  config: Record<string, unknown>;
  existingRaw: string | null;
}> {
  const existingRaw = await readFile(configPath, "utf8").catch((error) => {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  const document = existingRaw
    ? YAML.parseDocument(existingRaw)
    : new YAML.Document({});
  return {
    document,
    config: toRecord(document.toJSON()),
    existingRaw,
  };
}

async function writeHermesConfigDocument(input: {
  configPath: string;
  document: YAML.Document;
  config: Record<string, unknown>;
  existingRaw: string | null;
}): Promise<string | null> {
  const backupPath = input.existingRaw
    ? `${input.configPath}.bak.${Date.now()}`
    : null;
  if (backupPath) {
    await atomicWriteFilePreservingMetadata(backupPath, input.existingRaw!, {
      metadataSourcePath: input.configPath,
    });
  }
  input.document.contents = input.document.createNode(input.config);
  await atomicWriteFilePreservingMetadata(
    input.configPath,
    input.document.toString(),
  );
  return backupPath;
}

interface ManagedModel {
  id: string;
  provider: string;
  providerName: string;
  source: string;
  baseUrl: string;
  apiMode: string | undefined;
  contextLength?: number;
  keyEnv?: string;
  credentialConfigured: boolean;
  credentialState: string;
  isDefault: boolean;
  reasoningEffort?: string;
  reasoningSupport: string;
  supportedReasoningEfforts: string[] | null;
}

function readManagedModelConfigs(
  config: Record<string, unknown>,
  env: Record<string, string>,
  defaultModel: string | null,
  defaultReasoningEffort: string | null | undefined,
): ManagedModel[] {
  const models: ManagedModel[] = [];
  const seen = new Set<string>();
  const seenEndpoint = new Map<string, number>();
  const modelConfig = readModelConfig(config.model);
  const customProviders = Array.isArray(config.custom_providers)
    ? config.custom_providers
    : [];

  for (const rawEntry of customProviders) {
    const entry = toRecord(rawEntry);
    const providerName =
      readStr(entry.name) ??
      readStr(entry.provider_name) ??
      readStr(entry.provider_key) ??
      "Custom Provider";
    const provider =
      readStr(entry.provider_key) ?? readStr(entry.provider) ?? "custom";
    const baseUrl =
      readStr(entry.base_url) ??
      readStr(entry.url) ??
      readStr(entry.api) ??
      "";
    const apiMode = inferApiMode(provider, baseUrl, readStr(entry.api_mode));
    const contextLength = readPositiveInteger(entry.context_length);
    const keyEnv =
      readStr(entry.key_env) ?? parseEnvReference(readStr(entry.api_key));
    const credentialState = readCredentialState(entry, env);

    for (const id of readEntryModelIds(entry)) {
      const key = modelConfigKey(provider, baseUrl, id);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const endpointKey = modelEndpointKey(baseUrl, id);
      const modelContextLength =
        readEntryModelContextLength(entry, id) ?? contextLength;
      const reasoningEffort = readEntryModelReasoningEffort(entry, id);
      const reasoningMetadata = modelReasoningMetadata({
        provider,
        baseUrl,
        modelId: id,
        apiMode,
      });
      models.push({
        id,
        provider,
        providerName,
        source: "custom_provider",
        baseUrl,
        apiMode,
        ...(modelContextLength ? { contextLength: modelContextLength } : {}),
        ...(keyEnv ? { keyEnv } : {}),
        credentialConfigured: credentialState === "configured",
        credentialState,
        isDefault: id === defaultModel,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...reasoningMetadata,
      });
      seenEndpoint.set(endpointKey, models.length - 1);
    }
  }

  if (defaultModel) {
    const provider = modelConfig.provider ?? "default";
    const baseUrl = modelConfig.baseUrl ?? "";
    const endpointMatchIndex = seenEndpoint.get(
      modelEndpointKey(baseUrl, defaultModel),
    );
    if (endpointMatchIndex !== undefined) {
      const existing = models[endpointMatchIndex];
      models[endpointMatchIndex] = {
        ...existing,
        apiMode: modelConfig.apiMode
          ? inferApiMode(provider, baseUrl, modelConfig.apiMode)
          : existing.apiMode,
        contextLength: existing.contextLength ?? modelConfig.contextLength,
        keyEnv: existing.keyEnv ?? modelConfig.keyEnv,
        isDefault: true,
        reasoningEffort:
          existing.reasoningEffort ??
          defaultReasoningEffort ??
          undefined,
      };
      return models.sort(
        (left, right) => Number(right.isDefault) - Number(left.isDefault),
      );
    }

    const key = modelConfigKey(provider, baseUrl, defaultModel);
    if (!seen.has(key)) {
      const credentialState = readModelCredentialState(modelConfig, env);
      const reasoningEffort =
        modelConfig.reasoningEffort ?? defaultReasoningEffort;
      models.unshift({
        id: defaultModel,
        provider,
        providerName: provider,
        source: "model_default",
        baseUrl,
        apiMode: inferApiMode(provider, baseUrl, modelConfig.apiMode),
        ...(modelConfig.contextLength
          ? { contextLength: modelConfig.contextLength }
          : {}),
        ...(modelConfig.keyEnv ? { keyEnv: modelConfig.keyEnv } : {}),
        credentialConfigured: credentialState === "configured",
        credentialState,
        isDefault: true,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...modelReasoningMetadata({
          provider,
          baseUrl,
          modelId: defaultModel,
          apiMode: inferApiMode(provider, baseUrl, modelConfig.apiMode),
        }),
      });
    }
  }

  return models.sort(
    (left, right) => Number(right.isDefault) - Number(left.isDefault),
  );
}

function readAuxiliaryCompressionModelId(
  config: Record<string, unknown>,
): string | null {
  const auxiliary = toRecord(config.auxiliary);
  const compression = toRecord(auxiliary.compression);
  return readStr(compression.model) ?? null;
}

function resolveCompressionModel(
  config: Record<string, unknown>,
  models: ManagedModel[],
): ManagedModel | null {
  const auxiliary = toRecord(config.auxiliary);
  const compression = toRecord(auxiliary.compression);
  const modelId = readStr(compression.model);
  if (!modelId) {
    return null;
  }
  const provider = readStr(compression.provider);
  const baseUrl = readStr(compression.base_url);
  const apiMode = readStr(compression.api_mode);
  return (
    models.find((model) => {
      if (model.id !== modelId) {
        return false;
      }
      if (provider && model.provider !== provider) {
        return false;
      }
      if (baseUrl && model.baseUrl !== baseUrl) {
        return false;
      }
      if (apiMode && model.apiMode !== apiMode) {
        return false;
      }
      return true;
    }) ??
    models.find((model) => model.id === modelId) ??
    null
  );
}

function findManagedModelById(
  models: ManagedModel[],
  id: string,
): ManagedModel | undefined {
  return models.find((model) => model.id === id);
}

function writeAuxiliaryCompressionModelConfig(
  config: Record<string, unknown>,
  model: ManagedModel,
  env: Record<string, string>,
): void {
  const auxiliary = ensureRecord(config, "auxiliary");
  const compression = ensureRecord(auxiliary, "compression");
  compression.provider = model.provider || "auto";
  compression.model = model.id;
  compression.api_mode = model.apiMode;
  if (model.contextLength) {
    compression.context_length = model.contextLength;
  } else {
    delete compression.context_length;
  }
  if (model.provider === "custom") {
    compression.base_url = model.baseUrl;
    const apiKey = resolveManagedModelApiKey(config, env, model);
    if (apiKey) {
      compression.api_key = apiKey;
    } else {
      delete compression.api_key;
    }
    return;
  }
  delete compression.base_url;
  delete compression.api_key;
}

function resolveManagedModelApiKey(
  config: Record<string, unknown>,
  env: Record<string, string>,
  model: ManagedModel,
): string | undefined {
  const defaultConfig = readModelConfig(config.model);
  if (
    defaultConfig.model === model.id &&
    (defaultConfig.provider ?? "default") === model.provider &&
    (defaultConfig.baseUrl ?? "") === model.baseUrl
  ) {
    const defaultKey = resolveConfiguredApiKey(
      defaultConfig.apiKey,
      defaultConfig.keyEnv,
      env,
    );
    if (defaultKey) {
      return defaultKey;
    }
  }
  const customProviders = Array.isArray(config.custom_providers)
    ? config.custom_providers
    : [];
  for (const rawEntry of customProviders) {
    const entry = toRecord(rawEntry);
    const provider =
      readStr(entry.provider_key) ?? readStr(entry.provider) ?? "custom";
    const baseUrl =
      readStr(entry.base_url) ??
      readStr(entry.url) ??
      readStr(entry.api) ??
      "";
    if (
      provider === model.provider &&
      baseUrl === model.baseUrl &&
      readEntryModelIds(entry).includes(model.id)
    ) {
      const apiKey = readStr(entry.api_key);
      const keyEnv = readStr(entry.key_env) ?? parseEnvReference(apiKey);
      return resolveConfiguredApiKey(apiKey, keyEnv, env);
    }
  }
  return undefined;
}

function resolveConfiguredApiKey(
  apiKey: string | undefined,
  keyEnv: string | undefined,
  env: Record<string, string>,
): string | undefined {
  if (apiKey && !parseEnvReference(apiKey)) {
    return apiKey;
  }
  if (keyEnv) {
    return env[keyEnv]?.trim() || undefined;
  }
  return undefined;
}

interface NormalizedModelConfigInput {
  id: string;
  provider: string;
  providerName: string;
  baseUrl: string;
  apiKey?: string;
  apiMode?: string;
  keyEnv?: string;
  contextLength?: number;
  reasoningEffort?: string;
  setDefault?: boolean;
}

function normalizeModelConfigInput(
  input: Record<string, unknown>,
): NormalizedModelConfigInput {
  const id = (input.id as string).trim();
  const provider = (input.provider as string).trim();
  const baseUrl = (input.baseUrl as string).trim();
  if (!id || !provider || !baseUrl) {
    throw new Error("model id, provider and baseUrl are required");
  }
  const contextLength = input.contextLength as number | undefined;
  if (
    contextLength !== undefined &&
    (!Number.isFinite(contextLength) || contextLength <= 0)
  ) {
    throw new Error("contextLength must be a positive integer");
  }
  const rawReasoningEffort = (input.reasoningEffort as string | undefined)?.trim();
  const reasoningEffort = normalizeReasoningEffort(rawReasoningEffort);
  if (rawReasoningEffort && !reasoningEffort) {
    throw new Error(
      "reasoningEffort must be none, minimal, low, medium, high or xhigh",
    );
  }
  return {
    ...input,
    id,
    provider,
    providerName:
      ((input.providerName as string | undefined)?.trim()) || provider,
    baseUrl,
    apiKey: (input.apiKey as string | undefined)?.trim() || undefined,
    apiMode:
      (input.apiMode as string | undefined)?.trim() || "chat_completions",
    keyEnv: (input.keyEnv as string | undefined)?.trim() || undefined,
    contextLength: contextLength ? Math.floor(contextLength) : undefined,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  } as NormalizedModelConfigInput;
}

function ensureCustomProvidersList(
  config: Record<string, unknown>,
): unknown[] {
  const existing = config.custom_providers;
  if (Array.isArray(existing)) {
    return existing;
  }
  const next: unknown[] = [];
  config.custom_providers = next;
  return next;
}

function retainModelDefaultAsCustomProvider(
  entries: unknown[],
  model: Record<string, unknown>,
): void {
  const id = (model.model as string | undefined)?.trim();
  if (!id) {
    return;
  }
  const provider = (model.provider as string | undefined)?.trim() || "default";
  const baseUrl = (model.baseUrl as string | undefined)?.trim() || "";
  const key = modelConfigKey(provider, baseUrl, id);
  const exists = entries.some((entry2) => {
    const record = toRecord(entry2);
    const entryProvider =
      readStr(record.provider_key) ?? readStr(record.provider) ?? "custom";
    const entryBaseUrl =
      readStr(record.base_url) ??
      readStr(record.url) ??
      readStr(record.api) ??
      "";
    return readEntryModelIds(record).some(
      (modelId) => modelConfigKey(entryProvider, entryBaseUrl, modelId) === key,
    );
  });
  if (exists) {
    return;
  }
  const entry: Record<string, unknown> = {
    name: provider,
    provider_key: provider,
    base_url: baseUrl,
    api_mode: inferApiMode(provider, baseUrl, model.apiMode as string | undefined),
    model: id,
  };
  if (model.contextLength) {
    entry.context_length = model.contextLength;
  }
  if (model.reasoningEffort) {
    entry.reasoning_effort = model.reasoningEffort;
  }
  if (model.keyEnv) {
    entry.key_env = model.keyEnv;
  } else if (model.apiKey) {
    entry.api_key = model.apiKey;
  }
  entries.push(entry);
}

function writeDefaultModelConfig(
  modelConfig: Record<string, unknown>,
  model: {
    id: string;
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    keyEnv?: string;
    apiMode?: string;
    contextLength?: number;
  },
): void {
  modelConfig.default = model.id;
  modelConfig.provider = model.provider;
  modelConfig.base_url = model.baseUrl;
  if (model.keyEnv) {
    modelConfig.api_key = `\${${model.keyEnv}}`;
    delete modelConfig.key_env;
  } else if (model.apiKey) {
    modelConfig.api_key = model.apiKey;
    delete modelConfig.key_env;
  } else {
    delete modelConfig.api_key;
    delete modelConfig.key_env;
  }
  modelConfig.api_mode = inferApiMode(
    model.provider ?? "",
    model.baseUrl ?? "",
    model.apiMode,
  );
  if (model.contextLength) {
    modelConfig.context_length = model.contextLength;
  } else {
    delete modelConfig.context_length;
  }
}

function findCustomProviderIndex(entries: unknown[], modelId: string): number {
  return entries.findIndex((entry) =>
    readEntryModelIds(toRecord(entry)).includes(modelId),
  );
}

function updateEntryModels(
  entry: Record<string, unknown>,
  originalModelId: string,
  nextModelId: string,
): void {
  const models = entry.models;
  if (Array.isArray(models)) {
    const next = models
      .map((value) => (value === originalModelId ? nextModelId : value))
      .filter(
        (value) => typeof value === "string" && value.trim().length > 0,
      );
    if (!next.includes(nextModelId)) {
      next.unshift(nextModelId);
    }
    entry.models = Array.from(new Set(next));
    return;
  }
  if (
    typeof models === "object" &&
    models !== null &&
    originalModelId !== nextModelId &&
    originalModelId in models
  ) {
    const record = models as Record<string, unknown>;
    record[nextModelId] = record[originalModelId];
    delete record[originalModelId];
  }
}

function removeModelFromCustomProvider(
  entry: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> | null {
  if (
    readStr(entry.model) === modelId ||
    readStr(entry.default_model) === modelId
  ) {
    delete entry.model;
    delete entry.default_model;
  }
  const models = entry.models;
  if (Array.isArray(models)) {
    entry.models = models.filter((value) => value !== modelId);
  } else if (typeof models === "object" && models !== null) {
    delete (models as Record<string, unknown>)[modelId];
  }
  const remainingModels = readEntryModelIds(entry);
  if (remainingModels.length > 0) {
    entry.model = readStr(entry.model) ?? remainingModels[0];
    return entry;
  }
  return null;
}

function readEntryModelIds(entry: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const value of [entry.model, entry.default_model]) {
    if (typeof value === "string" && value.trim()) {
      ids.push(value.trim());
    }
  }
  const models = entry.models;
  if (Array.isArray(models)) {
    for (const value of models) {
      if (typeof value === "string" && value.trim()) {
        ids.push(value.trim());
      }
    }
  } else if (typeof models === "object" && models !== null) {
    ids.push(
      ...Object.keys(models)
        .map((key) => key.trim())
        .filter(Boolean),
    );
  }
  return Array.from(new Set(ids));
}

function readEntryModelContextLength(
  entry: Record<string, unknown>,
  modelId: string,
): number | undefined {
  const models = entry.models;
  if (
    typeof models !== "object" ||
    models === null ||
    Array.isArray(models)
  ) {
    return undefined;
  }
  const modelConfig = toRecord((models as Record<string, unknown>)[modelId]);
  return readPositiveInteger(
    (modelConfig.context_length ?? modelConfig.contextLength),
  );
}

function readEntryModelReasoningEffort(
  entry: Record<string, unknown>,
  modelId: string,
): string | undefined {
  const models = entry.models;
  if (
    typeof models === "object" &&
    models !== null &&
    !Array.isArray(models)
  ) {
    const modelConfig = toRecord(
      (models as Record<string, unknown>)[modelId],
    );
    const modelReasoning = normalizeReasoningEffort(
      modelConfig.reasoning_effort ?? modelConfig.reasoningEffort,
    );
    if (modelReasoning) {
      return modelReasoning;
    }
  }
  return normalizeReasoningEffort(
    entry.reasoning_effort ?? entry.reasoningEffort,
  );
}

function writeEntryModelReasoningEffort(
  entry: Record<string, unknown>,
  modelId: string,
  reasoningEffort: string | undefined,
): void {
  const models = entry.models;
  if (
    typeof models === "object" &&
    models !== null &&
    !Array.isArray(models)
  ) {
    const modelMap = models as Record<string, unknown>;
    const modelConfig = toRecord(modelMap[modelId]);
    if (reasoningEffort) {
      modelConfig.reasoning_effort = reasoningEffort;
    } else {
      delete modelConfig.reasoning_effort;
      delete modelConfig.reasoningEffort;
    }
    modelMap[modelId] = modelConfig;
    return;
  }
  if (reasoningEffort) {
    entry.reasoning_effort = reasoningEffort;
  } else {
    delete entry.reasoning_effort;
    delete entry.reasoningEffort;
  }
}

function readCredentialState(
  entry: Record<string, unknown>,
  env: Record<string, string>,
): string {
  const apiKey = readStr(entry.api_key);
  const keyEnv =
    readStr(entry.key_env) ?? parseEnvReference(apiKey);
  if (apiKey && !parseEnvReference(apiKey)) {
    return "configured";
  }
  if (!keyEnv) {
    return "unknown";
  }
  return env[keyEnv]?.trim() ? "configured" : "missing";
}

function readModelCredentialState(
  model: { apiKey?: string; keyEnv?: string },
  env: Record<string, string>,
): string {
  if (model.apiKey && !model.keyEnv) {
    return "configured";
  }
  if (!model.keyEnv) {
    return "unknown";
  }
  return env[model.keyEnv]?.trim() ? "configured" : "missing";
}

function modelConfigKey(
  provider: string,
  baseUrl: string,
  modelId: string,
): string {
  return [provider, baseUrl.replace(/\/+$/u, ""), modelId]
    .join("\n")
    .toLowerCase();
}

function modelEndpointKey(baseUrl: string, modelId: string): string {
  return [baseUrl.replace(/\/+$/u, ""), modelId].join("\n").toLowerCase();
}

function inferApiMode(
  provider: string,
  baseUrl: string,
  explicit?: string,
): string | undefined {
  const normalizedExplicit = explicit?.trim();
  if (normalizedExplicit) {
    return normalizedExplicit;
  }
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedBaseUrl = baseUrl
    .trim()
    .toLowerCase()
    .replace(/\/+$/u, "");
  if (normalizedProvider === "openai-codex") {
    return "codex_responses";
  }
  if (
    normalizedProvider === "anthropic" ||
    normalizedBaseUrl.endsWith("/anthropic") ||
    normalizedBaseUrl.includes("api.anthropic.com")
  ) {
    return "anthropic_messages";
  }
  return "chat_completions";
}

interface ReasoningMetadata {
  reasoningSupport: string;
  supportedReasoningEfforts: string[] | null;
}

function modelReasoningMetadata(input: {
  provider: string;
  baseUrl: string;
  modelId: string;
  apiMode: string | undefined;
}): ReasoningMetadata {
  const supported = inferSupportedReasoningEfforts(input);
  if (supported === null) {
    return {
      reasoningSupport: "unknown",
      supportedReasoningEfforts: null,
    };
  }
  if (supported.length === 0) {
    return {
      reasoningSupport: "unsupported",
      supportedReasoningEfforts: [],
    };
  }
  return {
    reasoningSupport: "known",
    supportedReasoningEfforts: ["none", ...supported],
  };
}

function inferSupportedReasoningEfforts(input: {
  provider: string;
  baseUrl: string;
  modelId: string;
  apiMode: string | undefined;
}): string[] | null {
  const provider = input.provider.trim().toLowerCase();
  const baseUrl = input.baseUrl.trim().toLowerCase();
  const modelId = input.modelId.trim().toLowerCase();

  if (
    provider.includes("github") ||
    provider.includes("copilot") ||
    baseUrl.includes("api.githubcopilot.com") ||
    baseUrl.includes("models.github.ai")
  ) {
    if (
      modelId.startsWith("openai/o1") ||
      modelId.startsWith("openai/o3") ||
      modelId.startsWith("openai/o4") ||
      modelId.startsWith("o1") ||
      modelId.startsWith("o3") ||
      modelId.startsWith("o4")
    ) {
      return ["low", "medium", "high"];
    }
    const normalizedModelId = modelId.includes("/")
      ? modelId.split("/").pop() ?? modelId
      : modelId;
    if (normalizedModelId.startsWith("gpt-5")) {
      return ["minimal", "low", "medium", "high"];
    }
    return [];
  }

  if (
    baseUrl.includes("nousresearch.com") ||
    baseUrl.includes("ai-gateway.vercel.sh")
  ) {
    return ["minimal", "low", "medium", "high", "xhigh"];
  }

  if (baseUrl.includes("openrouter")) {
    const reasoningPrefixes = [
      "deepseek/",
      "anthropic/",
      "openai/",
      "x-ai/",
      "google/gemini-2",
      "qwen/qwen3",
    ];
    return reasoningPrefixes.some((prefix) => modelId.startsWith(prefix))
      ? ["minimal", "low", "medium", "high", "xhigh"]
      : [];
  }

  if (input.apiMode === "anthropic_messages") {
    return null;
  }
  if (input.apiMode === "codex_responses") {
    return ["minimal", "low", "medium", "high", "xhigh"];
  }

  return null;
}

function readApiServerConfig(
  apiServerOrExtra: Record<string, unknown>,
  withDefaults = false,
): {
  enabled: boolean;
  host?: string;
  port?: number;
  key?: string;
} {
  const apiServer =
    "extra" in apiServerOrExtra ? apiServerOrExtra : {};
  const extra = toRecord(
    "extra" in apiServerOrExtra
      ? apiServerOrExtra.extra
      : apiServerOrExtra,
  );
  const port =
    typeof extra.port === "number" ? extra.port : undefined;
  const host =
    typeof extra.host === "string" ? extra.host : undefined;
  return {
    enabled: apiServer.enabled === true,
    host: withDefaults ? host ?? DEFAULT_HERMES_API_SERVER_HOST : host,
    port: withDefaults ? port ?? DEFAULT_HERMES_API_SERVER_PORT : port,
    key: typeof extra.key === "string" ? extra.key : undefined,
  };
}

function readModelConfig(value: unknown): {
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  keyEnv?: string;
  apiMode?: string;
  contextLength?: number;
  reasoningEffort?: string;
} {
  if (typeof value === "string") {
    return { model: value.trim() || undefined };
  }
  const model = toRecord(value);
  const contextLength = readPositiveInteger(model.context_length);
  const apiKey = readStr(model.api_key) ?? readStr(model.apiKey);
  const keyEnv = readStr(model.key_env) ?? parseEnvReference(apiKey);
  return {
    model:
      readStr(model.default) ??
      readStr(model.model) ??
      readStr(model.name),
    provider: readStr(model.provider),
    baseUrl: readStr(model.base_url),
    apiKey,
    keyEnv,
    apiMode: readStr(model.api_mode),
    contextLength,
    reasoningEffort: normalizeReasoningEffort(
      model.reasoning_effort ?? model.reasoningEffort,
    ),
  };
}

function readProfileReasoningEffort(
  config: Record<string, unknown>,
): string | null {
  const agent = toRecord(config.agent);
  return (
    normalizeReasoningEffort(
      agent.reasoning_effort ?? agent.reasoningEffort,
    ) ?? null
  );
}

function writeProfileReasoningEffort(
  config: Record<string, unknown>,
  reasoningEffort: string,
): void {
  const agent = ensureRecord(config, "agent");
  agent.reasoning_effort = reasoningEffort;
}

function normalizeReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return REASONING_EFFORTS.includes(normalized) ? normalized : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.replaceAll(",", ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function profilePermissionsFromConfig(
  profileName: string,
  configPath: string,
  config: Record<string, unknown>,
  env: Record<string, string>,
): Record<string, unknown> {
  const approvals = toRecord(config.approvals);
  const terminal = toRecord(config.terminal);
  const platformToolsets = toRecord(config.platform_toolsets);
  const apiServerToolsets = readStringList(platformToolsets.api_server);
  const hasExplicitToolsets = apiServerToolsets.some((toolset) =>
    API_SERVER_PROFILE_TOOLSET_KEYS.has(toolset),
  );
  const enabledToolsets = hasExplicitToolsets
    ? new Set(
        apiServerToolsets.filter((toolset) =>
          API_SERVER_PROFILE_TOOLSET_KEYS.has(toolset),
        ),
      )
    : API_SERVER_DEFAULT_ENABLED_TOOLSETS;

  return {
    profileName,
    configPath,
    approvals: {
      mode: readApprovalMode(approvals.mode),
      timeout: readPositiveInteger(approvals.timeout) ?? 60,
      cronMode: readCronApprovalMode(approvals.cron_mode),
    },
    terminal: {
      backend: readStr(terminal.backend) ?? "local",
      cwd: readStr(terminal.cwd) ?? ".",
      containerCpu: readPositiveInteger(terminal.container_cpu) ?? null,
      containerMemory: readPositiveInteger(terminal.container_memory) ?? null,
      containerDisk: readPositiveInteger(terminal.container_disk) ?? null,
      containerPersistent: terminal.container_persistent !== false,
    },
    toolsets: {
      items: PROFILE_PERMISSION_TOOLSETS.map((toolset) => {
        const configState = readToolsetConfigState(toolset.key, config, env);
        return {
          ...toolset,
          enabled:
            toolset.key === "stt"
              ? isSttEnabledFromConfig(config)
              : enabledToolsets.has(toolset.key),
          requiresConfig: configState.requiresConfig,
          configured: configState.configured,
        };
      }),
      mcpEnabled: !apiServerToolsets.includes("no_mcp"),
    },
    commandAllowlist: readStringList(config.command_allowlist),
  };
}

function readApprovalMode(value: unknown): string {
  const mode = readStr(value);
  return mode === "smart" || mode === "off" ? mode : "manual";
}

function readCronApprovalMode(value: unknown): string {
  const mode = readStr(value);
  return mode === "approve" || mode === "off" || mode === "allow"
    ? "approve"
    : "deny";
}

function readToolsetConfigState(
  key: string,
  config: Record<string, unknown>,
  env: Record<string, string>,
): { requiresConfig: boolean; configured: boolean } {
  switch (key) {
    case "web":
      return { requiresConfig: true, configured: isWebToolConfigured(config, env) };
    case "image_gen":
      return {
        requiresConfig: true,
        configured: isImageGenToolConfigured(config, env),
      };
    case "stt":
      return { requiresConfig: true, configured: isSttToolConfigured(config, env) };
    case "tts":
      return { requiresConfig: true, configured: isTtsToolConfigured(config, env) };
    case "messaging":
      return {
        requiresConfig: true,
        configured: ["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN"].some(
          (envKey) => isEnvValueConfigured(env[envKey]),
        ),
      };
    case "homeassistant":
      return {
        requiresConfig: true,
        configured: isEnvValueConfigured(env.HASS_TOKEN),
      };
    case "rl":
      return {
        requiresConfig: true,
        configured:
          isEnvValueConfigured(env.TINKER_API_KEY) &&
          isEnvValueConfigured(env.WANDB_API_KEY),
      };
    default:
      return { requiresConfig: false, configured: true };
  }
}

function isWebToolConfigured(
  config: Record<string, unknown>,
  env: Record<string, string>,
): boolean {
  const web = toRecord(config.web);
  const backend = readStr(web.backend)?.toLowerCase();
  if (backend === "firecrawl") {
    return (
      readConfigBoolean(web.use_gateway) === true ||
      isEnvValueConfigured(env.FIRECRAWL_API_KEY) ||
      isEnvValueConfigured(env.FIRECRAWL_API_URL)
    );
  }
  if (backend === "tavily") {
    return isEnvValueConfigured(env.TAVILY_API_KEY);
  }
  if (backend === "exa") {
    return isEnvValueConfigured(env.EXA_API_KEY);
  }
  if (backend === "parallel") {
    return isEnvValueConfigured(env.PARALLEL_API_KEY);
  }
  return (
    isEnvValueConfigured(env.FIRECRAWL_API_KEY) ||
    isEnvValueConfigured(env.FIRECRAWL_API_URL) ||
    isEnvValueConfigured(env.TAVILY_API_KEY) ||
    isEnvValueConfigured(env.EXA_API_KEY) ||
    isEnvValueConfigured(env.PARALLEL_API_KEY)
  );
}

function isImageGenToolConfigured(
  config: Record<string, unknown>,
  env: Record<string, string>,
): boolean {
  const imageGen = toRecord(config.image_gen);
  const provider = readStr(imageGen.provider)?.toLowerCase() ?? "fal";
  if (provider === "openai") {
    return isEnvValueConfigured(env.OPENAI_API_KEY);
  }
  if (provider === "xai") {
    return isEnvValueConfigured(env.XAI_API_KEY);
  }
  if (provider === "openai-codex") {
    return true;
  }
  return (
    readConfigBoolean(imageGen.use_gateway) === true ||
    isEnvValueConfigured(env.FAL_KEY)
  );
}

function isTtsToolConfigured(
  config: Record<string, unknown>,
  env: Record<string, string>,
): boolean {
  const tts = toRecord(config.tts);
  const provider = readStr(tts.provider)?.toLowerCase() ?? "edge";
  if (provider === "openai") {
    return (
      readConfigBoolean(tts.use_gateway) === true ||
      isEnvValueConfigured(env.VOICE_TOOLS_OPENAI_KEY) ||
      isEnvValueConfigured(env.OPENAI_API_KEY)
    );
  }
  if (provider === "elevenlabs") {
    return isEnvValueConfigured(env.ELEVENLABS_API_KEY);
  }
  if (provider === "minimax") {
    return isEnvValueConfigured(env.MINIMAX_API_KEY);
  }
  if (provider === "mistral") {
    return isEnvValueConfigured(env.MISTRAL_API_KEY);
  }
  if (provider === "gemini") {
    return isEnvValueConfigured(env.GEMINI_API_KEY);
  }
  if (provider === "xai") {
    return isEnvValueConfigured(env.XAI_API_KEY);
  }
  return true;
}

function isSttEnabledFromConfig(config: Record<string, unknown>): boolean {
  const stt = toRecord(config.stt);
  return readConfigBoolean(stt.enabled) ?? true;
}

function isSttToolConfigured(
  config: Record<string, unknown>,
  env: Record<string, string>,
): boolean {
  const stt = toRecord(config.stt);
  const provider = readStr(stt.provider)?.toLowerCase() ?? "local";
  if (provider === "local") {
    return true;
  }
  if (provider === "local_command") {
    return isEnvValueConfigured(env.HERMES_LOCAL_STT_COMMAND);
  }
  if (provider === "groq") {
    return isEnvValueConfigured(env.GROQ_API_KEY);
  }
  if (provider === "openai") {
    const openai = toRecord(stt.openai);
    const configApiKey = resolveConfiguredApiKey(readStr(openai.api_key), undefined, env);
    return (
      isEnvValueConfigured(configApiKey) ||
      isEnvValueConfigured(env.VOICE_TOOLS_OPENAI_KEY) ||
      isEnvValueConfigured(env.OPENAI_API_KEY)
    );
  }
  if (provider === "mistral") {
    return isEnvValueConfigured(env.MISTRAL_API_KEY);
  }
  if (provider === "xai") {
    return isEnvValueConfigured(env.XAI_API_KEY);
  }
  return false;
}

function normalizeApprovalMode(value: string): string {
  const mode = value.trim().toLowerCase();
  if (mode === "manual" || mode === "smart" || mode === "off") {
    return mode;
  }
  throw new Error("approvals.mode must be manual, smart or off");
}

function normalizeCronApprovalMode(value: string): string {
  const mode = value.trim().toLowerCase();
  if (mode === "deny" || mode === "approve") {
    return mode;
  }
  throw new Error("approvals.cron_mode must be deny or approve");
}

function normalizeTerminalBackend(value: string): string {
  const backend = value.trim().toLowerCase();
  if (TERMINAL_BACKENDS.has(backend)) {
    return backend;
  }
  throw new Error("terminal.backend is not supported");
}

function normalizeToolsetKey(value: string): string {
  const toolset = value.trim();
  if (PROFILE_PERMISSION_TOOLSET_KEYS.has(toolset)) {
    return toolset;
  }
  throw new Error(`unknown toolset: ${toolset}`);
}

function normalizePositiveInteger(value: number, field: string): number {
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  throw new Error(`${field} must be a positive integer`);
}

function normalizeNonEmptyString(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed) {
    return trimmed;
  }
  throw new Error(`${field} cannot be empty`);
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  ];
}

/** Internal helper: read a trimmed string or return undefined. */
function readStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeProfileToolConfigKey(value: string): string {
  const normalized = value.trim();
  if (
    normalized === "web" ||
    normalized === "image_gen" ||
    normalized === "stt" ||
    normalized === "tts" ||
    normalized === "messaging" ||
    normalized === "homeassistant" ||
    normalized === "rl"
  ) {
    return normalized;
  }
  throw new Error(`unsupported tool config "${value}"`);
}

function profileToolConfigFromSources(
  profileName: string,
  configPath: string,
  toolKey: string,
  config: Record<string, unknown>,
  env: Record<string, string>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const configured: Record<string, boolean> = {};

  switch (toolKey) {
    case "web": {
      const section = toRecord(config.web);
      const backend = readStr(section.backend)?.toLowerCase() ?? "firecrawl";
      const useGateway = readConfigBoolean(section.use_gateway) ?? false;
      values.provider =
        backend === "firecrawl" &&
        !useGateway &&
        !isEnvValueConfigured(env.FIRECRAWL_API_KEY) &&
        isEnvValueConfigured(env.FIRECRAWL_API_URL)
          ? "firecrawl_self_hosted"
          : backend;
      values.useGateway = useGateway;
      values.FIRECRAWL_API_URL = env.FIRECRAWL_API_URL?.trim() || "";
      for (const key of [
        "FIRECRAWL_API_KEY",
        "TAVILY_API_KEY",
        "EXA_API_KEY",
        "PARALLEL_API_KEY",
      ]) {
        configured[key] = isEnvValueConfigured(env[key]);
      }
      configured.FIRECRAWL_API_URL = isEnvValueConfigured(env.FIRECRAWL_API_URL);
      break;
    }
    case "image_gen": {
      const section = toRecord(config.image_gen);
      values.provider = readStr(section.provider) ?? "fal";
      values.model = readStr(section.model) ?? "";
      values.useGateway = readConfigBoolean(section.use_gateway) ?? false;
      for (const key of ["FAL_KEY", "OPENAI_API_KEY", "XAI_API_KEY"]) {
        configured[key] = isEnvValueConfigured(env[key]);
      }
      break;
    }
    case "stt": {
      const section = toRecord(config.stt);
      const local = toRecord(section.local);
      const openai = toRecord(section.openai);
      const mistral = toRecord(section.mistral);
      const xai = toRecord(section.xai);
      const openaiApiKeyRef = parseEnvReference(readStr(openai.api_key));
      const openaiConfigApiKey = resolveConfiguredApiKey(
        readStr(openai.api_key),
        undefined,
        env,
      );
      values.enabled = readConfigBoolean(section.enabled) ?? true;
      values.provider = readStr(section.provider) ?? "local";
      values.localModel = readStr(local.model) ?? "";
      values.localLanguage = readStr(local.language) ?? "";
      values.openaiModel =
        readStr(openai.model) ?? env.STT_OPENAI_MODEL?.trim() ?? "";
      values.openaiBaseUrl =
        readStr(openai.base_url) ?? env.STT_OPENAI_BASE_URL?.trim() ?? "";
      values.groqModel = env.STT_GROQ_MODEL?.trim() || "";
      values.groqBaseUrl = env.GROQ_BASE_URL?.trim() || "";
      values.mistralModel =
        readStr(mistral.model) ?? env.STT_MISTRAL_MODEL?.trim() ?? "";
      values.xaiLanguage = readStr(xai.language) ?? "";
      values.xaiBaseUrl =
        readStr(xai.base_url) ?? env.XAI_STT_BASE_URL?.trim() ?? "";
      values.xaiFormat = readConfigBoolean(xai.format) ?? true;
      values.xaiDiarize = readConfigBoolean(xai.diarize) ?? false;
      for (const key of [
        "GROQ_API_KEY",
        "MISTRAL_API_KEY",
        "XAI_API_KEY",
        "HERMES_LOCAL_STT_COMMAND",
        "HERMES_LOCAL_STT_LANGUAGE",
        "STT_GROQ_MODEL",
        "STT_OPENAI_MODEL",
        "STT_MISTRAL_MODEL",
        "STT_OPENAI_BASE_URL",
        "GROQ_BASE_URL",
        "XAI_STT_BASE_URL",
      ]) {
        configured[key] = isEnvValueConfigured(env[key]);
      }
      configured.VOICE_TOOLS_OPENAI_KEY =
        isEnvValueConfigured(env.VOICE_TOOLS_OPENAI_KEY) ||
        (openaiApiKeyRef !== "OPENAI_API_KEY" &&
          isEnvValueConfigured(openaiConfigApiKey));
      configured.OPENAI_API_KEY =
        isEnvValueConfigured(env.OPENAI_API_KEY) ||
        (openaiApiKeyRef === "OPENAI_API_KEY" &&
          isEnvValueConfigured(openaiConfigApiKey));
      break;
    }
    case "tts": {
      const section = toRecord(config.tts);
      const openai = toRecord(section.openai);
      values.provider = readStr(section.provider) ?? "edge";
      values.useGateway = readConfigBoolean(section.use_gateway) ?? false;
      values.baseUrl = readStr(openai.base_url) ?? "";
      values.model = readStr(openai.model) ?? "";
      values.voice = readStr(openai.voice) ?? "";
      for (const key of [
        "VOICE_TOOLS_OPENAI_KEY",
        "OPENAI_API_KEY",
        "ELEVENLABS_API_KEY",
        "MINIMAX_API_KEY",
        "MISTRAL_API_KEY",
        "GEMINI_API_KEY",
        "XAI_API_KEY",
      ]) {
        configured[key] = isEnvValueConfigured(env[key]);
      }
      break;
    }
    case "messaging": {
      for (const key of [
        "TELEGRAM_BOT_TOKEN",
        "DISCORD_BOT_TOKEN",
        "SLACK_BOT_TOKEN",
        "SLACK_APP_TOKEN",
      ]) {
        configured[key] = isEnvValueConfigured(env[key]);
      }
      for (const key of [
        "TELEGRAM_ALLOWED_USERS",
        "TELEGRAM_HOME_CHANNEL",
        "DISCORD_ALLOWED_USERS",
        "DISCORD_HOME_CHANNEL",
        "SLACK_ALLOWED_USERS",
        "SLACK_HOME_CHANNEL",
      ]) {
        values[key] = env[key]?.trim() || "";
      }
      break;
    }
    case "homeassistant":
      values.HASS_URL = env.HASS_URL?.trim() || "";
      configured.HASS_TOKEN = isEnvValueConfigured(env.HASS_TOKEN);
      break;
    case "rl":
      values.WANDB_ENTITY = env.WANDB_ENTITY?.trim() || "";
      configured.TINKER_API_KEY = isEnvValueConfigured(env.TINKER_API_KEY);
      configured.WANDB_API_KEY = isEnvValueConfigured(env.WANDB_API_KEY);
      break;
  }

  return { profileName, configPath, toolKey, values, configured };
}

function applyWebToolConfig(
  config: Record<string, unknown>,
  values: Record<string, unknown>,
): boolean {
  let changed = false;
  const section = ensureRecord(config, "web");
  const provider =
    readToolConfigString(values.provider) ??
    readToolConfigString(values.backend);
  if (provider !== undefined) {
    if (
      !["firecrawl", "firecrawl_self_hosted", "tavily", "exa", "parallel"].includes(
        provider,
      )
    ) {
      throw new Error("web.backend is not supported");
    }
    section.backend =
      provider === "firecrawl_self_hosted" ? "firecrawl" : provider;
    changed = true;
  }
  const useGateway = readToolConfigBoolean(values.useGateway);
  if (useGateway !== undefined) {
    section.use_gateway = useGateway;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(values, "FIRECRAWL_API_URL")) {
    const apiUrl = readToolConfigString(values.FIRECRAWL_API_URL);
    if (apiUrl) {
      values.FIRECRAWL_API_URL = normalizeToolConfigHttpUrl(
        apiUrl,
        "FIRECRAWL_API_URL",
      );
    }
  }
  return changed;
}

function applyImageGenToolConfig(
  config: Record<string, unknown>,
  values: Record<string, unknown>,
): boolean {
  let changed = false;
  const section = ensureRecord(config, "image_gen");
  const provider = readToolConfigString(values.provider);
  if (provider !== undefined) {
    if (!["fal", "openai", "xai", "openai-codex"].includes(provider)) {
      throw new Error("image_gen.provider is not supported");
    }
    section.provider = provider;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(values, "model")) {
    const model = readToolConfigString(values.model);
    if (model) {
      section.model = model;
    } else {
      delete section.model;
    }
    changed = true;
  }
  const useGateway = readToolConfigBoolean(values.useGateway);
  if (useGateway !== undefined) {
    section.use_gateway = useGateway;
    changed = true;
  }
  return changed;
}

function applyOptionalNestedToolString(
  parent: Record<string, unknown>,
  sectionKey: string,
  targetKey: string,
  values: Record<string, unknown>,
  inputKeys: string[],
): boolean {
  const inputKey = inputKeys.find((key) =>
    Object.prototype.hasOwnProperty.call(values, key),
  );
  if (!inputKey) {
    return false;
  }
  const section = ensureRecord(parent, sectionKey);
  const value = readToolConfigString(values[inputKey]);
  if (value) {
    section[targetKey] = value;
  } else {
    delete section[targetKey];
  }
  return true;
}

function applyOptionalNestedToolBoolean(
  parent: Record<string, unknown>,
  sectionKey: string,
  targetKey: string,
  values: Record<string, unknown>,
  inputKeys: string[],
): boolean {
  const inputKey = inputKeys.find((key) =>
    Object.prototype.hasOwnProperty.call(values, key),
  );
  if (!inputKey) {
    return false;
  }
  const section = ensureRecord(parent, sectionKey);
  const value = readToolConfigBoolean(values[inputKey]);
  if (value === undefined) {
    delete section[targetKey];
  } else {
    section[targetKey] = value;
  }
  return true;
}

function applySttToolConfig(
  config: Record<string, unknown>,
  values: Record<string, unknown>,
  env: Record<string, string>,
): boolean {
  let changed = false;
  const section = ensureRecord(config, "stt");

  const enabled = readToolConfigBoolean(values.enabled);
  if (enabled !== undefined) {
    section.enabled = enabled;
    changed = true;
  }

  const provider = readToolConfigString(values.provider);
  if (provider !== undefined) {
    if (
      !["local", "local_command", "groq", "openai", "mistral", "xai"].includes(
        provider,
      )
    ) {
      throw new Error("stt.provider is not supported");
    }
    section.provider = provider;
    changed = true;
  }

  const localModelTouched = applyOptionalNestedToolString(
    section,
    "local",
    "model",
    values,
    ["localModel", "local_model"],
  );
  const localLanguageTouched = applyOptionalNestedToolString(
    section,
    "local",
    "language",
    values,
    ["localLanguage", "local_language"],
  );
  changed = changed || localModelTouched || localLanguageTouched;

  const localCommand = readToolConfigString(
    values.localCommand ?? values.HERMES_LOCAL_STT_COMMAND,
  );
  if (localCommand) {
    values.HERMES_LOCAL_STT_COMMAND = localCommand;
  }

  const groqModel = readToolConfigString(
    values.groqModel ?? values.groq_model ?? values.STT_GROQ_MODEL,
  );
  if (groqModel) {
    values.STT_GROQ_MODEL = groqModel;
  }

  const groqBaseUrl = readToolConfigString(
    values.groqBaseUrl ?? values.groq_base_url ?? values.GROQ_BASE_URL,
  );
  if (groqBaseUrl) {
    values.GROQ_BASE_URL = normalizeToolConfigHttpUrl(
      groqBaseUrl,
      "GROQ_BASE_URL",
    );
  }

  const openaiModelTouched = applyOptionalNestedToolString(
    section,
    "openai",
    "model",
    values,
    ["openaiModel", "openai_model", "STT_OPENAI_MODEL"],
  );
  const openaiBaseUrlTouched = applyOptionalNestedToolString(
    section,
    "openai",
    "base_url",
    values,
    ["openaiBaseUrl", "openai_base_url", "STT_OPENAI_BASE_URL"],
  );
  if (openaiBaseUrlTouched) {
    const openai = toRecord(section.openai);
    const baseUrl = readStr(openai.base_url);
    if (baseUrl) {
      openai.base_url = normalizeToolConfigHttpUrl(
        baseUrl,
        "stt.openai.base_url",
      );
      ensureOpenAiSttApiKeyReference(openai, values, env);
    }
  }
  deleteEmptyNestedToolSection(section, "openai");
  changed = changed || openaiModelTouched || openaiBaseUrlTouched;

  const mistralModelTouched = applyOptionalNestedToolString(
    section,
    "mistral",
    "model",
    values,
    ["mistralModel", "mistral_model", "STT_MISTRAL_MODEL"],
  );
  deleteEmptyNestedToolSection(section, "mistral");
  changed = changed || mistralModelTouched;

  const xaiLanguageTouched = applyOptionalNestedToolString(
    section,
    "xai",
    "language",
    values,
    ["xaiLanguage", "xai_language"],
  );
  const xaiBaseUrlTouched = applyOptionalNestedToolString(
    section,
    "xai",
    "base_url",
    values,
    ["xaiBaseUrl", "xai_base_url", "XAI_STT_BASE_URL"],
  );
  if (xaiBaseUrlTouched) {
    const xai = toRecord(section.xai);
    const baseUrl = readStr(xai.base_url);
    if (baseUrl) {
      xai.base_url = normalizeToolConfigHttpUrl(baseUrl, "stt.xai.base_url");
    }
  }

  const xaiFormatTouched = applyOptionalNestedToolBoolean(
    section,
    "xai",
    "format",
    values,
    ["xaiFormat", "xai_format"],
  );
  const xaiDiarizeTouched = applyOptionalNestedToolBoolean(
    section,
    "xai",
    "diarize",
    values,
    ["xaiDiarize", "xai_diarize"],
  );

  deleteEmptyNestedToolSection(section, "local");
  deleteEmptyNestedToolSection(section, "xai");

  return (
    changed ||
    xaiLanguageTouched ||
    xaiBaseUrlTouched ||
    xaiFormatTouched ||
    xaiDiarizeTouched
  );
}

function deleteEmptyNestedToolSection(
  parent: Record<string, unknown>,
  key: string,
): void {
  const section = toRecord(parent[key]);
  if (Object.keys(section).length === 0) {
    delete parent[key];
  }
}

function ensureOpenAiSttApiKeyReference(
  openai: Record<string, unknown>,
  values: Record<string, unknown>,
  env: Record<string, string>,
): void {
  if (readStr(openai.api_key)) {
    return;
  }
  if (
    readToolConfigString(values.VOICE_TOOLS_OPENAI_KEY) ||
    isEnvValueConfigured(env.VOICE_TOOLS_OPENAI_KEY)
  ) {
    openai.api_key = "${VOICE_TOOLS_OPENAI_KEY}";
    return;
  }
  if (
    readToolConfigString(values.OPENAI_API_KEY) ||
    isEnvValueConfigured(env.OPENAI_API_KEY)
  ) {
    openai.api_key = "${OPENAI_API_KEY}";
  }
}

function applyTtsToolConfig(
  config: Record<string, unknown>,
  values: Record<string, unknown>,
): boolean {
  let changed = false;
  const section = ensureRecord(config, "tts");

  const provider = readToolConfigString(values.provider);
  if (provider !== undefined) {
    if (
      ![
        "edge",
        "openai",
        "elevenlabs",
        "minimax",
        "mistral",
        "gemini",
        "xai",
        "neutts",
        "kittentts",
      ].includes(provider)
    ) {
      throw new Error("tts.provider is not supported");
    }
    section.provider = provider;
    changed = true;
  }

  const useGateway = readToolConfigBoolean(values.useGateway);
  if (useGateway !== undefined) {
    section.use_gateway = useGateway;
    changed = true;
    if (useGateway) {
      const openai = toRecord(section.openai);
      if (Object.prototype.hasOwnProperty.call(openai, "base_url")) {
        delete openai.base_url;
        if (Object.keys(openai).length === 0) {
          delete section.openai;
        }
      }
    }
  }

  const requestedBaseUrl = readToolConfigString(
    values.baseUrl ?? values.base_url,
  );
  if ((readConfigBoolean(section.use_gateway) ?? false) && requestedBaseUrl) {
    throw new Error(
      "tts.openai.base_url cannot be used with tts.use_gateway",
    );
  }

  const openaiBaseUrlTouched = applyOptionalNestedToolString(
    section,
    "openai",
    "base_url",
    values,
    ["baseUrl", "base_url"],
  );
  const openaiModelTouched = applyOptionalNestedToolString(
    section,
    "openai",
    "model",
    values,
    ["model"],
  );
  const openaiVoiceTouched = applyOptionalNestedToolString(
    section,
    "openai",
    "voice",
    values,
    ["voice"],
  );
  const openaiTouched =
    openaiBaseUrlTouched || openaiModelTouched || openaiVoiceTouched;
  if (openaiTouched) {
    const openai = toRecord(section.openai);
    if (typeof openai.base_url === "string" && openai.base_url.trim()) {
      openai.base_url = normalizeToolConfigHttpUrl(
        openai.base_url,
        "tts.openai.base_url",
      );
    }
    if (Object.keys(openai).length === 0) {
      delete section.openai;
    }
    changed = true;
  }

  return changed;
}

async function writeToolConfigEnvValues(
  profileName: string,
  values: Record<string, unknown>,
  allowedKeys: string[],
): Promise<void> {
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      continue;
    }
    const value = readToolConfigString(values[key]);
    if (value) {
      await writeHermesEnvValue(profileName, key, value);
    }
  }
}

function readToolConfigString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function normalizeToolConfigHttpUrl(value: string, field: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (!trimmed) {
    throw new Error(`${field} cannot be empty`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must start with http:// or https://`);
  }
  return trimmed;
}

function readToolConfigBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return parseEnvBoolean(value);
  }
  return undefined;
}

function readConfigBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return parseEnvBoolean(value);
  }
  return undefined;
}

function shouldAssignDedicatedProfileApiServerPort(
  profileName: string,
  configuredPort: number | undefined,
): boolean {
  if (profileName === "default") {
    return false;
  }
  return (
    configuredPort === undefined ||
    configuredPort === DEFAULT_HERMES_API_SERVER_PORT
  );
}

async function nextProfileApiServerPort(profileName: string): Promise<number> {
  const usedPorts = await readConfiguredApiServerPorts(profileName);
  for (
    let port = PROFILE_API_SERVER_PORT_START;
    port <= PROFILE_API_SERVER_PORT_END;
    port += 1
  ) {
    if (!usedPorts.has(port) && (await isLoopbackPortAvailable(port))) {
      return port;
    }
  }
  throw new Error("no available Hermes API Server profile port");
}

async function readConfiguredApiServerPorts(
  excludedProfileName: string,
): Promise<Set<number>> {
  const ports = new Set<number>([DEFAULT_HERMES_API_SERVER_PORT]);
  await addConfiguredApiServerPort(ports, "default", excludedProfileName);
  const profilesRoot = path.join(
    resolveDefaultHermesRoot(resolveHermesProfileDir("default")),
    "profiles",
  );
  const entries = await readdir(profilesRoot, { withFileTypes: true }).catch(
    (error) => {
      if (isNodeError(error, "ENOENT")) {
        return [];
      }
      throw error;
    },
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    await addConfiguredApiServerPort(ports, entry.name, excludedProfileName);
  }
  return ports;
}

async function addConfiguredApiServerPort(
  ports: Set<number>,
  profileName: string,
  excludedProfileName: string,
): Promise<void> {
  if (profileName === excludedProfileName) {
    return;
  }
  const raw = await readFile(resolveHermesConfigPath(profileName), "utf8").catch(
    (error) => {
      if (isNodeError(error, "ENOENT")) {
        return "";
      }
      throw error;
    },
  );
  if (!raw.trim()) {
    return;
  }
  const config = toRecord(YAML.parse(raw));
  const apiServer = toRecord(toRecord(config.platforms).api_server);
  const port = readApiServerConfig(apiServer).port;
  if (typeof port === "number" && Number.isFinite(port)) {
    ports.add(port);
  }
}

function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (available: boolean) => {
      server.removeAllListeners();
      resolve(available);
    };
    server.once("error", () => finish(false));
    server.once("listening", () => {
      server.close(() => finish(true));
    });
    server.listen({
      host: DEFAULT_HERMES_API_SERVER_HOST,
      port,
      exclusive: true,
    });
  });
}

async function withProfileApiServerPortAssignmentLock<T>(
  task: () => Promise<T>,
): Promise<T> {
  const previous = profileApiServerPortAssignmentQueue;
  let release!: () => void;
  profileApiServerPortAssignmentQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => void 0);
  try {
    return await task();
  } finally {
    release();
  }
}

function isEnvValueConfigured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

async function readHermesApiServerEnvOverrides(profileName: string): Promise<{
  enabled?: boolean;
  host?: string;
  port?: number;
  key?: string;
}> {
  const values = await readHermesEnvFile(profileName);
  for (const key of [
    "API_SERVER_ENABLED",
    "API_SERVER_HOST",
    "API_SERVER_PORT",
    "API_SERVER_KEY",
  ]) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      values[key] = value;
    }
  }
  const port = Number.parseInt(values.API_SERVER_PORT ?? "", 10);
  return {
    enabled: parseEnvBoolean(values.API_SERVER_ENABLED),
    host: values.API_SERVER_HOST?.trim() || undefined,
    port: Number.isFinite(port) ? port : undefined,
    key: values.API_SERVER_KEY?.trim() || undefined,
  };
}

async function readHermesEnvFile(
  profileName: string,
): Promise<Record<string, string>> {
  const envPath = path.join(resolveHermesProfileDir(profileName), ".env");
  const raw = await readFile(envPath, "utf8").catch((error) => {
    if (isNodeError(error, "ENOENT")) {
      return "";
    }
    throw error;
  });
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match =
      /^(?:export\s+)?(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/u.exec(
        trimmed,
      );
    if (!match?.groups) {
      continue;
    }
    values[match.groups.key] = unquoteEnvValue(match.groups.value.trim());
  }
  return values;
}

async function writeHermesEnvValue(
  profileName: string,
  key: string,
  value: string,
): Promise<void> {
  const envPath = path.join(resolveHermesProfileDir(profileName), ".env");
  const existingRaw = await readFile(envPath, "utf8").catch((error) => {
    if (isNodeError(error, "ENOENT")) {
      return "";
    }
    throw error;
  });
  const lines = existingRaw ? existingRaw.split(/\r?\n/u) : [];
  const keyPattern = new RegExp(
    `^(?:export\\s+)?${escapeRegExp(key)}=`,
    "u",
  );
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (!keyPattern.test(line.trim())) {
      return line;
    }
    replaced = true;
    return `${key}=${formatEnvValue(value)}`;
  });
  if (!replaced) {
    if (nextLines.length > 0 && nextLines.at(-1) !== "") {
      nextLines.push("");
    }
    nextLines.push(`${key}=${formatEnvValue(value)}`);
  }
  const nextRaw = nextLines.join("\n").replace(/\n*$/u, "\n");
  if (existingRaw) {
    await atomicWriteFilePreservingMetadata(
      `${envPath}.bak.${Date.now()}`,
      existingRaw,
      { metadataSourcePath: envPath },
    );
  }
  await atomicWriteFilePreservingMetadata(envPath, nextRaw);
}

function applyEnvOverrides(
  config: {
    enabled?: boolean;
    host?: string;
    port?: number;
    key?: string;
  },
  env: {
    enabled?: boolean;
    host?: string;
    port?: number;
    key?: string;
  },
  withDefaults: boolean,
): Record<string, unknown> {
  const host = config.host ?? env.host;
  const port = config.port ?? env.port;
  return {
    enabled: config.enabled ?? env.enabled,
    host: withDefaults ? host ?? DEFAULT_HERMES_API_SERVER_HOST : host,
    port: withDefaults ? port ?? DEFAULT_HERMES_API_SERVER_PORT : port,
    key: config.key ?? env.key,
  };
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvReference(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const match =
    /^\$\{(?<key>[A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value.trim());
  return match?.groups?.key;
}

function buildApiKeyEnvName(providerName: string, modelId: string): string {
  const base = `${providerName || modelId}`
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return `HERMES_${base || "MODEL"}_API_KEY`;
}

function formatEnvValue(value: string): string {
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildNotice(flags: {
  keyAdded: boolean;
  enabledAdded: boolean;
  hostAdded: boolean;
  portAdded: boolean;
  port?: number;
}): string {
  const fields: string[] = [];
  if (flags.enabledAdded) {
    fields.push("enabled");
  }
  if (flags.hostAdded) {
    fields.push("host=127.0.0.1");
  }
  if (flags.portAdded) {
    fields.push(`port=${flags.port ?? DEFAULT_HERMES_API_SERVER_PORT}`);
  }
  if (flags.keyAdded) {
    fields.push("key");
  }
  return `已为 Hermes API Server 自动补充 ${fields.join("、")}；未覆盖已有 port/host/key。`;
}

export function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function ensureRecord(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = parent[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function resolveHermesConfiguredPath(value: string, baseDir: string): string {
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(baseDir, value);
}

function resolveDefaultHermesRoot(hermesHome: string): string {
  if (path.basename(path.dirname(hermesHome)) === "profiles") {
    return path.dirname(path.dirname(hermesHome));
  }
  return hermesHome;
}

// Re-export MIN_API_SERVER_VERSION to surface it from this module if needed
export { MIN_API_SERVER_VERSION };
