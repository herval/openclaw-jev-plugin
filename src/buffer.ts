/**
 * Per-conversation ring buffer of the last few messages.
 *
 * The buffer is the only memory the gate has. Messages the gate silences never
 * reach the agent session, so they must be kept here or the next Jev call would
 * not see them.
 */
export type BufferedRole = "user" | "assistant";

export type AssistantAction = "replied" | "stayed_silent" | "mentioned";

export type BufferedMessage = {
  role: BufferedRole;
  sender: string;
  text: string;
  timestamp: number;
  /** What the gate decided for a user message, filled in after the decision. */
  assistantAction?: AssistantAction;
};

export type ConversationBuffer = {
  append(key: string, message: BufferedMessage): BufferedMessage;
  recent(key: string): BufferedMessage[];
  markLast(key: string, action: AssistantAction): void;
  conversationCount(): number;
};

export const MAX_TEXT_LENGTH = 400;
const MAX_CONVERSATIONS = 500;

export function truncateText(text: string, max = MAX_TEXT_LENGTH): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) {
    return collapsed;
  }
  return `${collapsed.slice(0, max - 1)}…`;
}

export function createConversationBuffer(options: {
  size: number;
  maxConversations?: number;
}): ConversationBuffer {
  const size = Math.max(1, Math.floor(options.size));
  const maxConversations = Math.max(1, options.maxConversations ?? MAX_CONVERSATIONS);
  // Map preserves insertion order, so re-inserting on touch gives an LRU.
  const conversations = new Map<string, BufferedMessage[]>();

  function touch(key: string): BufferedMessage[] {
    const existing = conversations.get(key);
    if (existing) {
      conversations.delete(key);
      conversations.set(key, existing);
      return existing;
    }
    const created: BufferedMessage[] = [];
    conversations.set(key, created);
    while (conversations.size > maxConversations) {
      const oldest = conversations.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      conversations.delete(oldest);
    }
    return created;
  }

  return {
    append(key, message) {
      const entries = touch(key);
      const stored: BufferedMessage = { ...message, text: truncateText(message.text) };
      entries.push(stored);
      while (entries.length > size) {
        entries.shift();
      }
      return stored;
    },
    recent(key) {
      return [...(conversations.get(key) ?? [])];
    },
    markLast(key, action) {
      const entries = conversations.get(key);
      const last = entries?.[entries.length - 1];
      if (last && last.role === "user") {
        last.assistantAction = action;
      }
    },
    conversationCount() {
      return conversations.size;
    },
  };
}
