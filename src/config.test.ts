import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, resolveSettings } from "./config.js";

describe("resolveSettings", () => {
  it("falls back to defaults and environment variables", () => {
    const settings = resolveSettings(undefined, {
      TYPESAFE_API_KEY: " key ",
      TYPESAFE_BASE_URL: "https://proxy.test",
      TYPESAFE_DEFAULT_MODEL: "jev-2",
    });
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, apiKey: "key", baseUrl: "https://proxy.test", model: "jev-2" });
    expect(settings.assistantName).toBeUndefined();
  });

  it("prefers plugin config and clamps numbers", () => {
    const settings = resolveSettings(
      {
        assistantName: "Pato",
        bufferSize: 0.2,
        timeoutMs: 10,
        apiKey: "cfg",
        replyGate: {
          mentionPatterns: ["duck", 3, " "],
          threshold: 1.7,
          failOpen: false,
          evaluateDirectMessages: true,
        },
      },
      { TYPESAFE_API_KEY: "env" },
    );
    expect(settings.assistantName).toBe("Pato");
    expect(settings.bufferSize).toBe(1);
    expect(settings.timeoutMs).toBe(100);
    expect(settings.apiKey).toBe("cfg");
    expect(settings.replyGate).toEqual({
      enabled: true,
      mentionPatterns: ["duck"],
      threshold: 1,
      failOpen: false,
      evaluateDirectMessages: true,
    });
  });

  it("turns each feature on and off from its own block", () => {
    expect(resolveSettings({}, {}).replyGate.enabled).toBe(true);
    expect(resolveSettings({}, {}).modelRouter.enabled).toBe(false);

    const settings = resolveSettings(
      {
        replyGate: { enabled: false },
        modelRouter: {
          enabled: true,
          tiers: { light: " anthropic/claude-haiku-4-5 ", standard: "", heavy: 7 },
          lightBelow: -1,
          maxPromptChars: 10,
        },
      },
      {},
    );
    expect(settings.replyGate.enabled).toBe(false);
    expect(settings.modelRouter).toEqual({
      ...DEFAULT_SETTINGS.modelRouter,
      enabled: true,
      tiers: { light: "anthropic/claude-haiku-4-5", standard: undefined, heavy: undefined },
      lightBelow: 0,
      maxPromptChars: 200,
    });
    // A block that is not an object is ignored, not fatal.
    expect(resolveSettings({ modelRouter: "yes" }, {}).modelRouter).toEqual(DEFAULT_SETTINGS.modelRouter);
  });

  it("uses an apiKey the host resolved from a SecretRef", () => {
    const settings = resolveSettings({ apiKey: "resolved" }, { TYPESAFE_API_KEY: "env" });
    expect(settings.apiKey).toBe("resolved");
    expect(settings.unresolvedApiKeyRef).toBeUndefined();
  });

  it("flags an unresolved SecretRef and falls back to the environment", () => {
    const ref = { source: "store", provider: "default", id: "TYPESAFE_API_KEY" };
    const settings = resolveSettings({ apiKey: ref }, { TYPESAFE_API_KEY: "env" });
    expect(settings.apiKey).toBe("env");
    expect(settings.unresolvedApiKeyRef).toEqual({ source: "store", provider: "default" });
    expect(resolveSettings({ apiKey: ref }, {}).apiKey).toBeUndefined();
  });
});
