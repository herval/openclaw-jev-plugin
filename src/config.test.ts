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
  });

  it("prefers plugin config and clamps numbers", () => {
    const settings = resolveSettings(
      {
        assistantName: "Pato",
        mentionPatterns: ["duck", 3, " "],
        threshold: 1.7,
        bufferSize: 0.2,
        timeoutMs: 10,
        apiKey: "cfg",
        failOpen: false,
        evaluateDirectMessages: true,
      },
      { TYPESAFE_API_KEY: "env" },
    );
    expect(settings.assistantName).toBe("Pato");
    expect(settings.mentionPatterns).toEqual(["duck"]);
    expect(settings.threshold).toBe(1);
    expect(settings.bufferSize).toBe(1);
    expect(settings.timeoutMs).toBe(100);
    expect(settings.apiKey).toBe("cfg");
    expect(settings.failOpen).toBe(false);
    expect(settings.evaluateDirectMessages).toBe(true);
  });
});
