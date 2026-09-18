import { describe, expect, it } from "vitest";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  PluginHookBeforeDispatchContext,
  PluginHookBeforeDispatchEvent,
  PluginHookAgentContext,
  PluginHookHandlerMap,
  PluginRuntime,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_SETTINGS,
  type JevGateSettings,
  type ModelRouterSettings,
  type ReplyGateSettings,
} from "./config.js";
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

type SettingsOverrides = Partial<Omit<JevGateSettings, "replyGate" | "modelRouter">> & {
  replyGate?: Partial<ReplyGateSettings>;
  modelRouter?: Partial<ModelRouterSettings>;
};

function settings(overrides: SettingsOverrides = {}): JevGateSettings {
  const { replyGate, modelRouter, ...shared } = overrides;
  return {
    ...DEFAULT_SETTINGS,
    apiKey: "k",
    ...shared,
    replyGate: { ...DEFAULT_SETTINGS.replyGate, ...replyGate },
    modelRouter: { ...DEFAULT_SETTINGS.modelRouter, ...modelRouter },
  };
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

/** Answers the router's questions. `effort` is a level from 0 to 3, as Jev reports it. */
function jevRouting(effort: number, highStakes = 0, confidence = 0.9): JevClient & { calls: number; states: unknown[] } {
  const client = {
    calls: 0,
    states: [] as unknown[],
    async systemOne(state: unknown) {
      client.calls += 1;
      client.states.push(state);
      return {
        model: "jev-test",
        answers: {
          effort: { type: "score", score: effort, confidence, probabilities: {} },
          highStakes: { type: "noul", noul: highStakes },
        },
      } as never;
    },
  };
  return client;
}

const TIERS = { light: "anthropic/claude-haiku-4-5", standard: undefined, heavy: "anthropic/claude-opus-5" };

const runCtx: PluginHookAgentContext = {
  runId: "r1",
  sessionKey: "agent:main:slack:group:g1",
  channelId: "slack",
  trigger: "user",
};

async function resolveModel(handlers: Handlers, prompt: string, over: Partial<PluginHookAgentContext> = {}) {
  const handler = handlers.before_model_resolve;
  if (!handler) {
    throw new Error("before_model_resolve not registered");
  }
  return await handler({ prompt }, { ...runCtx, ...over });
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
      settings: settings({ assistantName: "Quack", replyGate: { mentionPatterns: ["/\\bduck\\b/"] } }),
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
    registerJevGate(gated.api, { settings: settings({ replyGate: { evaluateDirectMessages: true } }), jev });
    expect(await dispatch(gated.handlers, groupEvent("hello", { isGroup: false }))).toEqual({ handled: true });
    expect(jev.calls).toBe(1);
  });

  it("silences a group message Jev rates below the threshold and replies above it", async () => {
    const { api, handlers, logs } = fakeApi();
    const handle = registerJevGate(api, { settings: settings({ replyGate: { threshold: 0.6 } }), jev: jevAnswering(0.3) });
    expect(await dispatch(handlers, groupEvent("lunch anyone?"))).toEqual({ handled: true });
    expect(handle.buffer.recent(ctx.sessionKey!)[0]?.assistantAction).toBe("stayed_silent");
    expect(logs.some((l) => l.startsWith("info jev-gate: silent"))).toBe(true);

    const replying = fakeApi();
    registerJevGate(replying.api, { settings: settings({ replyGate: { threshold: 0.6 } }), jev: jevAnswering(0.9) });
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
    registerJevGate(closed.api, { settings: settings({ replyGate: { failOpen: false } }), jev: jevFailing() });
    expect(await dispatch(closed.handlers, groupEvent("hm"))).toEqual({ handled: true });
    expect(await dispatch(closed.handlers, groupEvent("pato?"))).toBeUndefined();
  });

  it("warns and applies the failure policy when no API key is configured", async () => {
    const { api, handlers, logs } = fakeApi();
    registerJevGate(api, { settings: settings({ apiKey: undefined, replyGate: { failOpen: false } }) });
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

  it("registers no router hook unless the router is enabled", () => {
    const { api, handlers } = fakeApi();
    registerJevGate(api, { settings: settings(), jev: jevAnswering(0) });
    expect(handlers.before_model_resolve).toBeUndefined();
  });

  it("registers nothing when every feature is disabled", () => {
    const { api, handlers, logs } = fakeApi();
    registerJevGate(api, { settings: settings({ replyGate: { enabled: false } }), jev: jevAnswering(0) });
    expect(handlers).toEqual({});
    expect(logs).toEqual(["info jev-gate: every feature is disabled; no hooks registered"]);
  });

  it("routes a run to the tier Jev's effort and stakes point at", async () => {
    const route = async (jev: JevClient) => {
      const { api, handlers } = fakeApi();
      registerJevGate(api, { settings: settings({ modelRouter: { enabled: true, tiers: TIERS } }), jev });
      return await resolveModel(handlers, "hi");
    };
    expect(await route(jevRouting(0.2))).toEqual({ providerOverride: "anthropic", modelOverride: "claude-haiku-4-5" });
    expect(await route(jevRouting(2.8))).toEqual({ providerOverride: "anthropic", modelOverride: "claude-opus-5" });
    // Standard has no model configured, so the agent keeps its own.
    expect(await route(jevRouting(1.5))).toBeUndefined();
    // Low effort, but Jev is unsure or the stakes are high: never the light tier.
    expect(await route(jevRouting(0.2, 0, 0.3))).toBeUndefined();
    expect(await route(jevRouting(0.2, 0.9))).toBeUndefined();
    expect(await route(jevRouting(1.5, 0.9))).toEqual({ providerOverride: "anthropic", modelOverride: "claude-opus-5" });
  });

  it("routes only user-triggered runs and keeps the agent's model when Jev fails", async () => {
    const { api, handlers, logs } = fakeApi();
    const jev = jevRouting(0.2);
    registerJevGate(api, { settings: settings({ modelRouter: { enabled: true, tiers: TIERS } }), jev });
    expect(await resolveModel(handlers, "tick", { trigger: "heartbeat" })).toBeUndefined();
    expect(jev.calls).toBe(0);
    expect(await resolveModel(handlers, "hi", { trigger: undefined })).toBeDefined();

    const failing = fakeApi();
    registerJevGate(failing.api, {
      settings: settings({ modelRouter: { enabled: true, tiers: TIERS } }),
      jev: jevFailing(),
    });
    expect(await resolveModel(failing.handlers, "hi")).toBeUndefined();
    expect(failing.logs.some((l) => l.includes("keeping the agent's model"))).toBe(true);
    expect(logs.some((l) => l === "info jev-gate: replyGate on, modelRouter on")).toBe(true);
  });

  it("runs the router with the gate off, still feeding it the conversation", async () => {
    const { api, handlers, logs } = fakeApi();
    const jev = jevRouting(0.2);
    registerJevGate(api, {
      settings: settings({ replyGate: { enabled: false }, modelRouter: { enabled: true } }),
      jev,
      now: () => 9_000,
    });
    expect(logs).toContain("info jev-gate: modelRouter has no tiers configured; decisions are logged and the model is never changed");

    // The gate is off: nothing is silenced and Jev is not asked about the message.
    expect(await dispatch(handlers, groupEvent("anyone seen the deploy?"))).toBeUndefined();
    handlers.message_sent?.({ to: "g1", content: "it is green", success: true, sessionKey: ctx.sessionKey }, {});
    expect(await dispatch(handlers, groupEvent("thanks"))).toBeUndefined();
    expect(jev.calls).toBe(0);

    expect(await resolveModel(handlers, "[Slack] ana: thanks")).toBeUndefined();
    expect(jev.states[0]).toMatchObject({
      assistant: { name: "Pato" },
      request: "[Slack] ana: thanks",
      // The newest message is already in the prompt, so it is not repeated here.
      conversation: { recentMessages: [{ text: "anyone seen the deploy?" }, { from: "assistant", text: "it is green" }] },
    });
    expect(logs.some((l) => l.startsWith("info jev-gate: route light -> agent default"))).toBe(true);
  });

  it("builds a conversation key from the session, then the conversation, then channel and sender", () => {
    expect(conversationKey(groupEvent("x"), ctx)).toBe("agent:main:slack:group:g1");
    expect(conversationKey(groupEvent("x", { sessionKey: undefined }), { ...ctx, sessionKey: undefined })).toBe("g1");
    expect(
      conversationKey(groupEvent("x", { sessionKey: undefined }), { channelId: "slack", senderId: "ana" }),
    ).toBe("slack:ana");
  });
});
