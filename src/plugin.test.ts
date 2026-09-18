import { describe, expect, it } from "vitest";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  PluginHookBeforeDispatchContext,
  PluginHookBeforeDispatchEvent,
  PluginHookHandlerMap,
  PluginRuntime,
} from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_SETTINGS, type JevGateSettings } from "./config.js";
import type { JevClient } from "./jev-client.js";
import { conversationKey, registerJevGate } from "./plugin.js";

type Handlers = Partial<PluginHookHandlerMap>;

const HOST_CONFIG: OpenClawConfig = {
  agents: {
    list: [
      { id: "main", default: true, identity: { name: "Pato" } },
      { id: "ops", identity: { name: "Ganso" } },
    ],
  },
};

/** Stands in for the host: the name comes from the agent identity, mentions are derived from it. */
function fakeRuntime(): PluginRuntime {
  const identityOf = (cfg: OpenClawConfig | undefined, agentId?: string) =>
    cfg?.agents?.list?.find((agent) => agent.id === agentId)?.identity;
  return {
    agent: { resolveAgentIdentity: identityOf },
    channel: {
      mentions: {
        buildMentionRegexes: (cfg, agentId) => {
          const name = identityOf(cfg, agentId)?.name;
          return name ? [new RegExp(`(?:@|\\b)${name}\\b`, "i")] : [];
        },
        matchesMentionPatterns: (text, regexes) => regexes.some((re) => re.test(text)),
      },
    },
  };
}

function fakeApi(config: Record<string, unknown> = {}, hostConfig: OpenClawConfig = HOST_CONFIG) {
  const handlers: Handlers = {};
  const logs: string[] = [];
  const api = {
    id: "jev-gate",
    name: "Jev Reply Gate",
    config: hostConfig,
    pluginConfig: config,
    runtime: fakeRuntime(),
    logger: {
      debug: (m: string) => logs.push(`debug ${m}`),
      info: (m: string) => logs.push(`info ${m}`),
      warn: (m: string) => logs.push(`warn ${m}`),
      error: (m: string) => logs.push(`error ${m}`),
    },
    on: ((name: keyof Handlers, handler: Handlers[keyof Handlers]) => {
      (handlers as Record<string, unknown>)[name] = handler;
    }) as OpenClawPluginApi["on"],
  } satisfies OpenClawPluginApi;
  return { api, handlers, logs };
}

function settings(overrides: Partial<JevGateSettings> = {}): JevGateSettings {
  return { ...DEFAULT_SETTINGS, apiKey: "k", ...overrides };
}

function jevAnswering(wanted: number, addressed = 0): JevClient & { calls: number; states: unknown[] } {
  const client = {
    calls: 0,
    states: [] as unknown[],
    async systemOne(state: unknown) {
      client.calls += 1;
      client.states.push(state);
      return {
        model: "jev-test",
        answers: {
          addressedToAssistant: { type: "noul", noul: addressed },
          wantsAssistantReply: { type: "noul", noul: wanted },
          audience: { type: "choice", choice: "whole_group", confidence: 0.5, probabilities: {} },
        },
      } as never;
    },
  };
  return client;
}

function jevFailing(): JevClient & { calls: number } {
  const client = {
    calls: 0,
    async systemOne(): Promise<never> {
      client.calls += 1;
      throw new Error("boom");
    },
  };
  return client;
}

const groupEvent = (text: string, extra: Partial<PluginHookBeforeDispatchEvent> = {}): PluginHookBeforeDispatchEvent => ({
  content: text,
  body: text,
  channel: "slack",
  sessionKey: "agent:main:slack:group:g1",
  senderId: "ana",
  isGroup: true,
  timestamp: 1_000,
  ...extra,
});

const ctx: PluginHookBeforeDispatchContext = {
  channelId: "slack",
  conversationId: "g1",
  sessionKey: "agent:main:slack:group:g1",
  senderId: "ana",
};

async function dispatch(handlers: Handlers, event: PluginHookBeforeDispatchEvent) {
  const handler = handlers.before_dispatch;
  if (!handler) {
    throw new Error("before_dispatch not registered");
  }
  return await handler(event, ctx);
}

describe("registerJevGate", () => {
  it("registers before_dispatch and message_sent", () => {
    const { api, handlers } = fakeApi();
    registerJevGate(api, { settings: settings(), jev: jevAnswering(0) });
    expect(typeof handlers.before_dispatch).toBe("function");
    expect(typeof handlers.message_sent).toBe("function");
  });

  it("always answers a mention without asking Jev", async () => {
    const { api, handlers } = fakeApi();
    const jev = jevAnswering(0);
    const handle = registerJevGate(api, { settings: settings(), jev });
    expect(await dispatch(handlers, groupEvent("@pato what's up"))).toBeUndefined();
    expect(await dispatch(handlers, groupEvent("ok", { replyToSender: "Pato" }))).toBeUndefined();
    expect(jev.calls).toBe(0);
    expect(handle.buffer.recent(ctx.sessionKey!).map((m) => m.assistantAction)).toEqual([
      "mentioned",
      "mentioned",
    ]);
  });

  it("takes the assistant name and mentions from the agent that owns the session", async () => {
    const { api, handlers } = fakeApi();
    const jev = jevAnswering(0);
    const handle = registerJevGate(api, { settings: settings(), jev });
    const opsKey = "agent:ops:slack:group:g1";

    // "pato" is another agent's name, so for the ops agent it is not a mention.
    expect(await dispatch(handlers, groupEvent("pato, lunch?", { sessionKey: opsKey }))).toEqual({ handled: true });
    expect(jev.states[0]).toMatchObject({ assistant: { name: "Ganso" } });
    expect(await dispatch(handlers, groupEvent("@ganso deploy status?", { sessionKey: opsKey }))).toBeUndefined();
    expect(jev.calls).toBe(1);

    handlers.message_sent?.({ to: "g1", content: "all green", success: true, sessionKey: opsKey }, {});
    expect(handle.buffer.recent(opsKey).at(-1)).toMatchObject({ role: "assistant", sender: "Ganso" });
  });

  it("falls back to the default agent, then to a generic name", async () => {
    const { api, handlers } = fakeApi();
    const jev = jevAnswering(0);
    registerJevGate(api, { settings: settings(), jev });
    await dispatch(handlers, groupEvent("lunch?", { sessionKey: "slack:group:g1" }));
    expect(jev.states[0]).toMatchObject({ assistant: { name: "Pato" } });

    const bare = fakeApi({}, {});
    const bareJev = jevAnswering(0);
    registerJevGate(bare.api, { settings: settings(), jev: bareJev });
    await dispatch(bare.handlers, groupEvent("lunch?"));
    expect(bareJev.states[0]).toMatchObject({ assistant: { name: "assistant" } });
  });

  it("lets plugin config override the name and add mention patterns", async () => {
    const { api, handlers } = fakeApi();
    const jev = jevAnswering(0);
    registerJevGate(api, {
      settings: settings({ assistantName: "Quack", mentionPatterns: ["/\\bduck\\b/"] }),
      jev,
    });
    expect(await dispatch(handlers, groupEvent("quack, you there?"))).toBeUndefined();
    expect(await dispatch(handlers, groupEvent("ask the duck"))).toBeUndefined();
    expect(await dispatch(handlers, groupEvent("@pato ping"))).toBeUndefined();
    expect(jev.calls).toBe(0);
    await dispatch(handlers, groupEvent("lunch?"));
    expect(jev.states[0]).toMatchObject({ assistant: { name: "Quack" } });
  });

  it("always answers direct messages unless configured otherwise", async () => {
    const { api, handlers } = fakeApi();
    const jev = jevAnswering(0);
    registerJevGate(api, { settings: settings(), jev });
    expect(await dispatch(handlers, groupEvent("hello", { isGroup: false }))).toBeUndefined();
    expect(jev.calls).toBe(0);

    const gated = fakeApi();
    registerJevGate(gated.api, { settings: settings({ evaluateDirectMessages: true }), jev });
    expect(await dispatch(gated.handlers, groupEvent("hello", { isGroup: false }))).toEqual({ handled: true });
    expect(jev.calls).toBe(1);
  });

  it("silences a group message Jev rates below the threshold and replies above it", async () => {
    const { api, handlers, logs } = fakeApi();
    const handle = registerJevGate(api, { settings: settings({ threshold: 0.6 }), jev: jevAnswering(0.3) });
    expect(await dispatch(handlers, groupEvent("lunch anyone?"))).toEqual({ handled: true });
    expect(handle.buffer.recent(ctx.sessionKey!)[0]?.assistantAction).toBe("stayed_silent");
    expect(logs.some((l) => l.startsWith("info jev-gate: silent"))).toBe(true);

    const replying = fakeApi();
    registerJevGate(replying.api, { settings: settings({ threshold: 0.6 }), jev: jevAnswering(0.9) });
    expect(await dispatch(replying.handlers, groupEvent("can someone find the report?"))).toBeUndefined();
  });

  it("keeps silenced messages and the bot's own replies in the buffer", async () => {
    const { api, handlers } = fakeApi();
    const handle = registerJevGate(api, {
      settings: settings({ bufferSize: 3 }),
      jev: jevAnswering(0),
      now: () => 5_000,
    });
    await dispatch(handlers, groupEvent("one"));
    await dispatch(handlers, groupEvent("two"));
    handlers.message_sent?.({ to: "g1", content: "reply", success: true, sessionKey: ctx.sessionKey }, {});
    handlers.message_sent?.({ to: "g1", content: "failed", success: false, sessionKey: ctx.sessionKey }, {});
    handlers.message_sent?.({ to: "g1", content: "no session", success: true }, {});
    await dispatch(handlers, groupEvent("three"));
    expect(handle.buffer.recent(ctx.sessionKey!).map((m) => `${m.role}:${m.text}`)).toEqual([
      "user:two",
      "assistant:reply",
      "user:three",
    ]);
  });

  it("fails open by default and fails closed when configured", async () => {
    const open = fakeApi();
    registerJevGate(open.api, { settings: settings(), jev: jevFailing() });
    expect(await dispatch(open.handlers, groupEvent("hm"))).toBeUndefined();
    expect(open.logs.some((l) => l.startsWith("warn jev-gate: Jev call failed"))).toBe(true);

    const closed = fakeApi();
    registerJevGate(closed.api, { settings: settings({ failOpen: false }), jev: jevFailing() });
    expect(await dispatch(closed.handlers, groupEvent("hm"))).toEqual({ handled: true });
    expect(await dispatch(closed.handlers, groupEvent("pato?"))).toBeUndefined();
  });

  it("warns and applies the failure policy when no API key is configured", async () => {
    const { api, handlers, logs } = fakeApi();
    registerJevGate(api, { settings: settings({ apiKey: undefined, failOpen: false }) });
    expect(logs[0]).toMatch(/no TypeSafe API key/);
    expect(await dispatch(handlers, groupEvent("hi all"))).toEqual({ handled: true });
  });

  it("warns when the apiKey SecretRef did not resolve", () => {
    const { api, logs } = fakeApi();
    registerJevGate(api, {
      settings: settings({ apiKey: undefined, unresolvedApiKeyRef: { source: "store", provider: "default" } }),
    });
    expect(logs[0]).toMatch(/SecretRef \(source=store, provider=default\) did not resolve/);
    expect(logs[1]).toMatch(/no TypeSafe API key/);
  });

  it("builds a conversation key from the session, then the conversation, then channel and sender", () => {
    expect(conversationKey(groupEvent("x"), ctx)).toBe("agent:main:slack:group:g1");
    expect(conversationKey(groupEvent("x", { sessionKey: undefined }), { ...ctx, sessionKey: undefined })).toBe("g1");
    expect(
      conversationKey(groupEvent("x", { sessionKey: undefined }), { channelId: "slack", senderId: "ana" }),
    ).toBe("slack:ana");
  });
});
