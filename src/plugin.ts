/**
 * Hook wiring. `before_dispatch` is a claim hook: returning `{ handled: true }`
 * without text ends the message before the model runs, which is how the gate
 * keeps the bot silent. Returning nothing lets ordinary dispatch continue.
 */
import type {
  OpenClawPluginApi,
  PluginHookBeforeDispatchContext,
  PluginHookBeforeDispatchEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import { createConversationBuffer, type ConversationBuffer } from "./buffer.js";
import { resolveSettings, type JevGateSettings } from "./config.js";
import { decideWithJev } from "./decide.js";
import { createAssistantResolver } from "./identity.js";
import { createJevClient, type JevClient } from "./jev-client.js";

export type JevGateDependencies = {
  jev?: JevClient;
  settings?: JevGateSettings;
  now?: () => number;
};

export type JevGateHandle = {
  settings: JevGateSettings;
  buffer: ConversationBuffer;
};

const SILENT = { handled: true } as const;

export function conversationKey(
  event: PluginHookBeforeDispatchEvent,
  ctx: PluginHookBeforeDispatchContext,
): string {
  return (
    event.sessionKey ??
    ctx.sessionKey ??
    ctx.conversationId ??
    `${ctx.channelId ?? event.channel ?? "unknown"}:${ctx.senderId ?? event.senderId ?? "unknown"}`
  );
}

export function registerJevGate(api: OpenClawPluginApi, deps: JevGateDependencies = {}): JevGateHandle {
  const settings = deps.settings ?? resolveSettings(api.pluginConfig);
  const now = deps.now ?? (() => Date.now());
  const buffer = createConversationBuffer({ size: settings.bufferSize });
  const assistants = createAssistantResolver(api, settings);
  const log = api.logger;

  if (settings.unresolvedApiKeyRef) {
    const { source, provider } = settings.unresolvedApiKeyRef;
    log.warn(
      `jev-gate: config.apiKey SecretRef (source=${source}, provider=${provider}) did not resolve; ` +
        (settings.apiKey ? "falling back to TYPESAFE_API_KEY" : "check `openclaw secrets list` and the ref id"),
    );
  }

  let jev: JevClient | undefined = deps.jev;
  if (!jev) {
    if (settings.apiKey) {
      jev = createJevClient({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
      });
    } else {
      log.warn(
        "jev-gate: no TypeSafe API key (set TYPESAFE_API_KEY or plugins.entries.jev-gate.config.apiKey, a string or SecretRef); " +
          (settings.failOpen ? "every message will be answered" : "only mentions will be answered"),
      );
    }
  }

  api.on("before_dispatch", async (event, ctx) => {
    const key = conversationKey(event, ctx);
    const text = (event.body ?? event.content ?? "").trim();
    const timestamp = event.timestamp ?? now();
    buffer.append(key, {
      role: "user",
      sender: event.senderId ?? ctx.senderId ?? "unknown",
      text,
      timestamp,
    });

    if (!event.isGroup && !settings.evaluateDirectMessages) {
      buffer.markLast(key, "replied");
      return undefined;
    }

    const assistant = assistants.resolve(event.sessionKey ?? ctx.sessionKey, {
      channel: ctx.channelId ?? event.channel,
      conversationId: ctx.conversationId,
    });
    if (assistant.mentions(text) || assistant.mentions(event.replyToSender)) {
      buffer.markLast(key, "mentioned");
      log.debug?.(`jev-gate: mention in ${key}, replying`);
      return undefined;
    }

    if (!jev) {
      buffer.markLast(key, settings.failOpen ? "replied" : "stayed_silent");
      return settings.failOpen ? undefined : SILENT;
    }

    try {
      const decision = await decideWithJev(
        jev,
        {
          assistantName: assistant.name,
          assistantDescription: settings.assistantDescription,
          channel: ctx.channelId ?? event.channel,
          isGroup: event.isGroup ?? true,
          recent: buffer.recent(key),
          now: now(),
        },
        settings.threshold,
      );
      buffer.markLast(key, decision.reply ? "replied" : "stayed_silent");
      log.info(`jev-gate: ${decision.reply ? "reply" : "silent"} for ${key} (${decision.reason})`);
      return decision.reply ? undefined : SILENT;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`jev-gate: Jev call failed for ${key}, ${settings.failOpen ? "replying" : "staying silent"}: ${message}`);
      buffer.markLast(key, settings.failOpen ? "replied" : "stayed_silent");
      return settings.failOpen ? undefined : SILENT;
    }
  });

  api.on("message_sent", (event) => {
    if (!event.success || !event.sessionKey) {
      return;
    }
    const text = event.content?.trim();
    if (!text) {
      return;
    }
    buffer.append(event.sessionKey, {
      role: "assistant",
      sender: assistants.resolve(event.sessionKey).name,
      text,
      timestamp: now(),
    });
  });

  return { settings, buffer };
}
