import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./config.js";
import { buildRouteState, pickTier, ROUTE_QUESTIONS, tailOf, toModelOverride } from "./route.js";

const thresholds = DEFAULT_SETTINGS.modelRouter;
const base = { effort: 0.5, confidence: 0.9, highStakes: 0, hasAttachments: false };

describe("pickTier", () => {
  it("sends high effort to the heavy tier and sure, low-effort chat to the light tier", () => {
    expect(pickTier({ ...base, effort: 0.9 }, thresholds)).toBe("heavy");
    expect(pickTier({ ...base, effort: 0.1 }, thresholds)).toBe("light");
    expect(pickTier(base, thresholds)).toBe("standard");
  });

  it("treats the thresholds as inclusive", () => {
    expect(pickTier({ ...base, effort: thresholds.heavyAbove }, thresholds)).toBe("heavy");
    expect(pickTier({ ...base, effort: thresholds.lightBelow }, thresholds)).toBe("light");
  });

  it("keeps uncertain, high-stakes or attachment-bearing requests off the light tier", () => {
    const low = { ...base, effort: 0.1 };
    expect(pickTier({ ...low, confidence: 0.2 }, thresholds)).toBe("standard");
    expect(pickTier({ ...low, highStakes: 0.6 }, thresholds)).toBe("standard");
    expect(pickTier({ ...low, hasAttachments: true }, thresholds)).toBe("standard");
  });

  it("escalates high stakes to heavy unless the request is trivial", () => {
    expect(pickTier({ ...base, highStakes: 0.8 }, thresholds)).toBe("heavy");
    expect(pickTier({ ...base, effort: 0.1, highStakes: 0.8 }, thresholds)).toBe("standard");
  });
});

describe("toModelOverride", () => {
  it("splits provider and model on the first slash", () => {
    expect(toModelOverride("anthropic/claude-haiku-4-5")).toEqual({
      providerOverride: "anthropic",
      modelOverride: "claude-haiku-4-5",
    });
    expect(toModelOverride("openrouter/meta/llama-3")).toEqual({
      providerOverride: "openrouter",
      modelOverride: "meta/llama-3",
    });
  });

  it("overrides only the model for a bare id and nothing for an empty one", () => {
    expect(toModelOverride("llama3.3:8b")).toEqual({ modelOverride: "llama3.3:8b" });
    expect(toModelOverride("  ")).toBeUndefined();
    expect(toModelOverride(undefined)).toBeUndefined();
  });
});

describe("buildRouteState", () => {
  it("keeps the end of a long prompt, where the current message sits", () => {
    expect(tailOf("abcdef", 10)).toBe("abcdef");
    expect(tailOf("abcdef", 3)).toBe("…def");
  });

  it("names attachments only when there are some", () => {
    const input = {
      assistantName: "Pato",
      assistantDescription: "helper",
      channel: "slack",
      prompt: "what is in this picture?",
      attachmentKinds: ["image"],
      recent: [{ role: "user" as const, sender: "ana", text: "hey", timestamp: 1_000 }],
      now: 4_000,
    };
    expect(buildRouteState(input, 4000)).toEqual({
      assistant: { name: "Pato", description: "helper" },
      conversation: { channel: "slack", recentMessages: [{ from: "participant:ana", text: "hey", secondsAgo: 3 }] },
      request: "what is in this picture?",
      attachments: ["image"],
    });
    expect(buildRouteState({ ...input, attachmentKinds: [] }, 4000)).not.toHaveProperty("attachments");
  });

  it("asks a score with 2 to 10 standalone levels", () => {
    expect(ROUTE_QUESTIONS.effort.type).toBe("score");
    expect(ROUTE_QUESTIONS.effort.criteria.length).toBeGreaterThanOrEqual(2);
    expect(ROUTE_QUESTIONS.effort.criteria.length).toBeLessThanOrEqual(10);
  });
});
