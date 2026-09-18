import { describe, expect, it } from "vitest";
import { createMentionMatcher } from "./mention.js";

describe("mention matcher", () => {
  const matcher = createMentionMatcher(["Pato", "/\\bbot\\b/", "@helper"]);

  it("matches plain names as whole words, case-insensitive, with or without @", () => {
    expect(matcher.matches("hey pato, what time is it")).toBe(true);
    expect(matcher.matches("@Pato help")).toBe(true);
    expect(matcher.matches("Pato: ping")).toBe(true);
    expect(matcher.matches("patos are birds")).toBe(false);
    expect(matcher.matches("sympatoco")).toBe(false);
  });

  it("supports /regex/ patterns and strips a leading @ from names", () => {
    expect(matcher.matches("is the BOT awake?")).toBe(true);
    expect(matcher.matches("robots everywhere")).toBe(false);
    expect(matcher.matches("thanks helper")).toBe(true);
  });

  it("ignores empty input and invalid patterns", () => {
    expect(matcher.matches(undefined)).toBe(false);
    expect(matcher.matches("")).toBe(false);
    const broken = createMentionMatcher(["/([/", "   "]);
    expect(broken.matches("anything")).toBe(false);
  });
});
