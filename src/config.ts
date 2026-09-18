/** Resolved plugin settings. Config values win over environment variables, then defaults. */
export type JevGateSettings = {
  assistantName: string;
  assistantDescription: string;
  mentionPatterns: string[];
  threshold: number;
  bufferSize: number;
  evaluateDirectMessages: boolean;
  failOpen: boolean;
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

export const DEFAULT_SETTINGS: Omit<JevGateSettings, "apiKey"> = {
  assistantName: "assistant",
  assistantDescription:
    "A helpful assistant that takes part in this chat. It answers questions and requests directed at it.",
  mentionPatterns: [],
  threshold: 0.6,
  bufferSize: 8,
  evaluateDirectMessages: false,
  failOpen: true,
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
  timeoutMs: 2500,
};

type Env = Record<string, string | undefined>;

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, value));
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.map(readString).filter((item): item is string => item !== undefined);
  return items;
}

export function resolveSettings(
  pluginConfig: Record<string, unknown> | undefined,
  env: Env = process.env,
): JevGateSettings {
  const cfg = pluginConfig ?? {};
  return {
    assistantName: readString(cfg.assistantName) ?? DEFAULT_SETTINGS.assistantName,
    assistantDescription:
      readString(cfg.assistantDescription) ?? DEFAULT_SETTINGS.assistantDescription,
    mentionPatterns: readStringList(cfg.mentionPatterns) ?? DEFAULT_SETTINGS.mentionPatterns,
    threshold: readNumber(cfg.threshold, 0, 1) ?? DEFAULT_SETTINGS.threshold,
    bufferSize: Math.round(readNumber(cfg.bufferSize, 1, 50) ?? DEFAULT_SETTINGS.bufferSize),
    evaluateDirectMessages:
      readBoolean(cfg.evaluateDirectMessages) ?? DEFAULT_SETTINGS.evaluateDirectMessages,
    failOpen: readBoolean(cfg.failOpen) ?? DEFAULT_SETTINGS.failOpen,
    apiKey: readString(cfg.apiKey) ?? readString(env.TYPESAFE_API_KEY),
    baseUrl: readString(cfg.baseUrl) ?? readString(env.TYPESAFE_BASE_URL) ?? DEFAULT_SETTINGS.baseUrl,
    model: readString(cfg.model) ?? readString(env.TYPESAFE_DEFAULT_MODEL) ?? DEFAULT_SETTINGS.model,
    timeoutMs: Math.round(readNumber(cfg.timeoutMs, 100, 60_000) ?? DEFAULT_SETTINGS.timeoutMs),
  };
}
