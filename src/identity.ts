/**
 * Resolves which agent a message belongs to, what that agent is called, and
 * whether a text mentions it. The host owns all three: the agent id is encoded
 * in the session key (`agent:<id>:...`), the name is `agents.list[].identity.name`,
 * and mention patterns follow the host's own precedence (agent `groupChat`,
 * then `messages.groupChat`, then patterns derived from the identity).
 *
 * Plugin config only adds to that: `assistantName` overrides the name and
 * `mentionPatterns` are extra patterns on top of the host's.
 */
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { JevGateSettings } from "./config.js";
import { createMentionMatcher } from "./mention.js";

export const FALLBACK_ASSISTANT_NAME = "assistant";

/** Mirrors the host's implicit agent id for configs without a roster. */
const IMPLICIT_AGENT_ID = "main";

const AGENT_SESSION_KEY = /^agent:([^:]+):/i;

export type AssistantScope = {
  channel?: string;
  conversationId?: string;
};

export type ResolvedAssistant = {
  agentId: string;
  name: string;
  mentions(text: string | undefined): boolean;
};

export type AssistantResolver = {
  resolve(sessionKey: string | undefined, scope?: AssistantScope): ResolvedAssistant;
};

export function agentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const match = AGENT_SESSION_KEY.exec(sessionKey?.trim() ?? "");
  return match ? match[1].toLowerCase() : undefined;
}

export function defaultAgentId(cfg: OpenClawConfig | undefined): string {
  const agents = cfg?.agents?.list ?? [];
  const agent = agents.find((entry) => entry?.default === true) ?? agents[0];
  return agent?.id?.trim().toLowerCase() || IMPLICIT_AGENT_ID;
}

export function createAssistantResolver(
  api: Pick<OpenClawPluginApi, "config" | "runtime">,
  settings: Pick<JevGateSettings, "assistantName"> & { mentionPatterns: readonly string[] },
): AssistantResolver {
  const extra = createMentionMatcher([
    ...(settings.assistantName ? [settings.assistantName] : []),
    ...settings.mentionPatterns,
  ]);

  return {
    resolve(sessionKey, scope = {}) {
      // Read `api.config` per message so a config reload is picked up.
      const cfg = api.config;
      const agentId = agentIdFromSessionKey(sessionKey) ?? defaultAgentId(cfg);
      const name =
        settings.assistantName ??
        (api.runtime.agent.resolveAgentIdentity(cfg, agentId)?.name?.trim() || FALLBACK_ASSISTANT_NAME);
      const { buildMentionRegexes, matchesMentionPatterns } = api.runtime.channel.mentions;
      let regexes: RegExp[] | undefined;
      return {
        agentId,
        name,
        mentions(text) {
          if (!text) {
            return false;
          }
          // The host caches compiled patterns, so building them per message is cheap.
          regexes ??= buildMentionRegexes(cfg, agentId, {
            provider: scope.channel,
            conversationId: scope.conversationId,
          });
          return matchesMentionPatterns(text, regexes) || extra.matches(text);
        },
      };
    },
  };
}
