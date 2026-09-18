/**
 * Minimal ambient typing for the OpenClaw plugin SDK surface this plugin uses.
 *
 * The real types live in the `openclaw` host package (src/plugins/hook-types.ts,
 * hook-message.types.ts, plugin-api.types.ts, runtime/types-core.ts,
 * runtime/types-channel.ts, logger-types.ts). The host aliases
 * `openclaw/plugin-sdk/*` at load time, so the package is a peer dependency and is
 * not installed here. Keep this file in sync with the fields the plugin reads.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export type PluginLogger = {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };

  export type PluginHookBeforeDispatchEvent = {
    messageId?: string;
    content: string;
    body?: string;
    channel?: string;
    sessionKey?: string;
    senderId?: string;
    replyToId?: string;
    replyToIdFull?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
    isGroup?: boolean;
    timestamp?: number;
  };

  export type PluginHookBeforeDispatchContext = {
    messageId?: string;
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
    senderId?: string;
    replyToId?: string;
    replyToIdFull?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
  };

  export type PluginHookBeforeDispatchResult = {
    handled: boolean;
    text?: string;
  };

  export type PluginHookMessageSentEvent = {
    to: string;
    content: string;
    success: boolean;
    messageId?: string;
    sessionKey?: string;
    runId?: string;
    error?: string;
  };

  export type PluginHookMessageContext = {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
    messageId?: string;
    senderId?: string;
    runId?: string;
  };

  export type PluginHookHandlerMap = {
    before_dispatch: (
      event: PluginHookBeforeDispatchEvent,
      ctx: PluginHookBeforeDispatchContext,
    ) => Promise<PluginHookBeforeDispatchResult | void> | PluginHookBeforeDispatchResult | void;
    message_sent: (
      event: PluginHookMessageSentEvent,
      ctx: PluginHookMessageContext,
    ) => Promise<void> | void;
  };

  export type PluginHookName = keyof PluginHookHandlerMap;

  export type PluginHookRegistrationOptions = {
    priority?: number;
    registrationId?: string;
    timeoutMs?: number;
  };

  export type IdentityConfig = {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
  };

  /** Host config. Only the agent roster is typed; the rest is opaque to this plugin. */
  export type OpenClawConfig = {
    agents?: {
      list?: Array<{ id: string; default?: boolean; identity?: IdentityConfig }>;
    };
    [key: string]: unknown;
  };

  export type BuildMentionRegexesOptions = {
    provider?: string;
    conversationId?: string | null;
  };

  export type PluginRuntime = {
    agent: {
      resolveAgentIdentity: (cfg: OpenClawConfig, agentId: string) => IdentityConfig | undefined;
    };
    channel: {
      mentions: {
        buildMentionRegexes: (
          cfg: OpenClawConfig | undefined,
          agentId?: string,
          options?: BuildMentionRegexesOptions,
        ) => RegExp[];
        matchesMentionPatterns: (text: string, mentionRegexes: RegExp[]) => boolean;
      };
    };
  };

  export type OpenClawPluginApi = {
    id: string;
    name: string;
    config: OpenClawConfig;
    pluginConfig?: Record<string, unknown>;
    runtime: PluginRuntime;
    logger: PluginLogger;
    on: <K extends PluginHookName>(
      hookName: K,
      handler: PluginHookHandlerMap[K],
      opts?: PluginHookRegistrationOptions,
    ) => void;
  };

  export type DefinePluginEntryOptions = {
    id: string;
    name: string;
    description: string;
    register: (api: OpenClawPluginApi) => void;
  };

  export function definePluginEntry(options: DefinePluginEntryOptions): unknown;
}
