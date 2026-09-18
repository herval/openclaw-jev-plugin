import { describe, expect, it } from "vitest";
import type { BufferedMessage } from "./buffer.js";
import { buildState, decideWithJev, QUESTIONS } from "./decide.js";
import type { JevClient } from "./jev-client.js";

const recent: BufferedMessage[] = [
  { role: "user", sender: "ana", text: "who has the report?", timestamp: 1_000, assistantAction: "stayed_silent" },
  { role: "assistant", sender: "bot", text: "I can find it.", timestamp: 2_000 },
  { role: "user", sender: "ana", text: "please do", timestamp: 3_000 },
];

const input = {
  assistantName: "bot",
  assistantDescription: "Finds documents.",
  channel: "slack",
  isGroup: true,
  recent,
  now: 10_000,
};

function fakeJev(answers: Record<string, unknown>): JevClient & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    async systemOne(state, questions) {
      requests.push({ state, questions });
      return { model: "jev-test", answers } as never;
    },
  };
}

describe("buildState", () => {
  it("separates history from the latest message and tags roles", () => {
    const state = buildState(input) as Record<string, unknown>;
    const conversation = state.conversation as { recentMessages: unknown[]; kind: string };
    expect(conversation.kind).toMatch(/group/);
    expect(conversation.recentMessages).toEqual([
      { from: "participant:ana", text: "who has the report?", secondsAgo: 9, assistantAction: "stayed_silent" },
      { from: "assistant", text: "I can find it.", secondsAgo: 8 },
    ]);
    expect(state.latestMessage).toEqual({ from: "participant:ana", text: "please do", secondsAgo: 7 });
  });
});

describe("decideWithJev", () => {
  it("replies when either probability clears the threshold", async () => {
    const jev = fakeJev({
      addressedToAssistant: { type: "noul", noul: 0.2 },
      wantsAssistantReply: { type: "noul", noul: 0.75 },
      audience: { type: "choice", choice: "whole_group", confidence: 0.5, probabilities: {} },
    });
    const decision = await decideWithJev(jev, input, 0.6);
    expect(decision.reply).toBe(true);
    expect(decision.probability).toBe(0.75);
    expect(decision.audience).toBe("whole_group");
    expect(jev.requests).toHaveLength(1);
    expect((jev.requests[0] as { questions: unknown }).questions).toBe(QUESTIONS);
  });

  it("stays silent below the threshold and tolerates malformed numbers", async () => {
    const jev = fakeJev({
      addressedToAssistant: { type: "noul", noul: "nope" },
      wantsAssistantReply: { type: "noul", noul: 0.59 },
      audience: { type: "choice", choice: "another_person", confidence: 0.9, probabilities: {} },
    });
    const decision = await decideWithJev(jev, input, 0.6);
    expect(decision.reply).toBe(false);
    expect(decision.reason).toContain("audience=another_person");
  });
});
