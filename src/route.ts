/**
 * Builds the Jev state and questions for one agent run and turns the answers
 * into a model tier. Jev supplies two independent judgments; the mapping from
 * those to a tier is plain code, so thresholds change without touching the
 * questions.
 */
import type { BufferedMessage } from "./buffer.js";
import type { ModelRouterSettings, ModelTiers } from "./config.js";
import { noul, score, type EntryType, type JevClient, type JsonValue } from "./jev-client.js";

export type Tier = keyof ModelTiers;

export type RouteInput = {
  assistantName: string;
  assistantDescription: string;
  channel: string | undefined;
  /** The prepared prompt for this run. The current message sits at the end. */
  prompt: string;
  attachmentKinds: readonly string[];
  /** Earlier messages in this conversation, oldest first. May be empty. */
  recent: readonly BufferedMessage[];
  now: number;
};

export type RouteDecision = {
  tier: Tier;
  /** Effort normalized to [0, 1]. */
  effort: number;
  reason: string;
};

export type ModelOverride = { providerOverride?: string; modelOverride?: string };

/** Ordered low to high. Each level stands on its own: Jev judges them separately. */
const EFFORT_LEVELS = [
  "Small talk, a greeting, thanks, an acknowledgement or a reaction. A one-line reply is enough.",
  "A simple factual question or lookup that a short, direct answer settles.",
  "A task with a few steps: explaining something in depth, writing or editing a moderate piece of text or code, or using a tool or two.",
  "A hard problem: multi-step reasoning, debugging, design or planning with trade-offs, long or careful writing, or many tool calls.",
] as const;

const MAX_EFFORT_LEVEL = EFFORT_LEVELS.length - 1;

export const ROUTE_QUESTIONS = {
  effort: score("How much work does it take to answer the request in `request` well?", EFFORT_LEVELS),
  highStakes: noul("Does getting the answer to the request in `request` wrong carry real consequences?", {
    true: "The answer drives a decision, changes code, data or infrastructure, involves money, or gets sent on to other people.",
    false: "A rough or wrong answer costs little and is easy to notice and correct.",
  }),
} as const;

/** Keeps the end of the prompt: the host puts the current message last, after any history. */
export function tailOf(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

export function buildRouteState(input: RouteInput, maxPromptChars: number): EntryType {
  const toJson = (message: BufferedMessage): { [key: string]: JsonValue } => ({
    from: message.role === "assistant" ? "assistant" : `participant:${message.sender}`,
    text: message.text,
    secondsAgo: Math.max(0, Math.round((input.now - message.timestamp) / 1000)),
  });
  return {
    assistant: { name: input.assistantName, description: input.assistantDescription },
    conversation: {
      ...(input.channel ? { channel: input.channel } : {}),
      recentMessages: input.recent.map(toJson),
    },
    request: tailOf(input.prompt, maxPromptChars),
    ...(input.attachmentKinds.length > 0 ? { attachments: [...input.attachmentKinds] } : {}),
  };
}

/**
 * Heavy on high effort, or on high stakes with anything past a trivial request.
 * Light only when effort is low, stakes are low, Jev is sure, and there is
 * nothing attached. Everything else, including every uncertain case, is standard.
 */
export function pickTier(
  answers: { effort: number; confidence: number; highStakes: number; hasAttachments: boolean },
  settings: Pick<ModelRouterSettings, "lightBelow" | "heavyAbove" | "minConfidence">,
): Tier {
  if (answers.effort >= settings.heavyAbove) {
    return "heavy";
  }
  if (answers.highStakes >= 0.7 && answers.effort > settings.lightBelow) {
    return "heavy";
  }
  if (
    answers.effort <= settings.lightBelow &&
    answers.highStakes < 0.5 &&
    answers.confidence >= settings.minConfidence &&
    !answers.hasAttachments
  ) {
    return "light";
  }
  return "standard";
}

export async function routeWithJev(
  jev: JevClient,
  input: RouteInput,
  settings: ModelRouterSettings,
  options?: { signal?: AbortSignal },
): Promise<RouteDecision> {
  const state = buildRouteState(input, settings.maxPromptChars);
  const { answers } = await jev.systemOne(state, ROUTE_QUESTIONS, options);
  const effort = clamp(answers.effort.score / MAX_EFFORT_LEVEL);
  const confidence = clamp(answers.effort.confidence);
  const highStakes = clamp(answers.highStakes.noul);
  const hasAttachments = input.attachmentKinds.length > 0;
  const tier = pickTier({ effort, confidence, highStakes, hasAttachments }, settings);
  const reason =
    `effort=${effort.toFixed(2)}(${confidence.toFixed(2)}) stakes=${highStakes.toFixed(2)}` +
    (hasAttachments ? " attachments" : "");
  return { tier, effort, reason };
}

/** Splits `provider/model` on the first slash. A bare id overrides the model only. */
export function toModelOverride(ref: string | undefined): ModelOverride | undefined {
  const trimmed = ref?.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { modelOverride: trimmed };
  }
  return { providerOverride: trimmed.slice(0, slash), modelOverride: trimmed.slice(slash + 1) };
}

function clamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
