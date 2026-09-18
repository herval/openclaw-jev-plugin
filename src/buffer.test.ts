import { describe, expect, it } from "vitest";
import { createConversationBuffer, truncateText } from "./buffer.js";

describe("conversation buffer", () => {
  it("keeps only the last N messages per conversation", () => {
    const buffer = createConversationBuffer({ size: 3 });
    for (let i = 1; i <= 5; i += 1) {
      buffer.append("a", { role: "user", sender: "u", text: `m${i}`, timestamp: i });
    }
    expect(buffer.recent("a").map((m) => m.text)).toEqual(["m3", "m4", "m5"]);
  });

  it("isolates conversations and evicts the least recently used one", () => {
    const buffer = createConversationBuffer({ size: 2, maxConversations: 2 });
    buffer.append("a", { role: "user", sender: "u", text: "a1", timestamp: 1 });
    buffer.append("b", { role: "user", sender: "u", text: "b1", timestamp: 2 });
    buffer.append("a", { role: "user", sender: "u", text: "a2", timestamp: 3 });
    buffer.append("c", { role: "user", sender: "u", text: "c1", timestamp: 4 });
    expect(buffer.recent("b")).toEqual([]);
    expect(buffer.recent("a").map((m) => m.text)).toEqual(["a1", "a2"]);
    expect(buffer.conversationCount()).toBe(2);
  });

  it("marks the last user message with the assistant action", () => {
    const buffer = createConversationBuffer({ size: 3 });
    buffer.append("a", { role: "user", sender: "u", text: "hi", timestamp: 1 });
    buffer.markLast("a", "stayed_silent");
    buffer.append("a", { role: "assistant", sender: "bot", text: "yo", timestamp: 2 });
    buffer.markLast("a", "replied");
    const [user, assistant] = buffer.recent("a");
    expect(user?.assistantAction).toBe("stayed_silent");
    expect(assistant?.assistantAction).toBeUndefined();
  });

  it("truncates long text and collapses whitespace", () => {
    expect(truncateText("  a   b\n\nc ")).toBe("a b c");
    const long = "x".repeat(1000);
    expect(truncateText(long)).toHaveLength(400);
    expect(truncateText(long).endsWith("…")).toBe(true);
  });
});
