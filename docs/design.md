# Jev decides when the OpenClaw bot replies

## Context

An OpenClaw bot in a group channel has two modes. With `requireMention: true` it answers only
when it is named. With `requireMention: false` it answers every message. Neither mode fits a
team chat where the bot should join in when a question is for it and stay quiet the rest of the
time.

TypeSafe released Jev on 2026-09-15. Jev is a decision model. It takes a state and typed
questions and returns calibrated probabilities instead of text. A call costs a fraction of a
cent and returns in under a second. That makes it cheap enough to ask on every group message.

This prototype connects the two. It is a prototype, not a production service.

## Approach / Changes

The plugin registers two OpenClaw hooks.

`before_dispatch` is a claim hook. OpenClaw runs it before the model. A handler that returns
`{ handled: true }` with no text ends the message silently. The plugin uses that return value
to keep the bot quiet. A handler that returns nothing lets the normal dispatch continue.

`message_sent` is an observe hook. The plugin uses it to add the bot's own replies to the
buffer.

The decision order is fixed:

1. Append the message to a per-conversation ring buffer keyed by `sessionKey`.
2. A direct message passes. This is configurable.
3. A mention passes. The agent is resolved from the session key, and the text is matched with
   the host's mention patterns for that agent plus extra patterns from the plugin config. A
   quoted reply to a message from the assistant also counts.
4. Otherwise ask Jev with the buffer as state and three questions: `addressedToAssistant`,
   `wantsAssistantReply`, and `audience`. Reply when the larger of the two probabilities is at
   or above the threshold.
5. Tag the buffered message with the outcome so the next call sees what the bot did.

A Jev failure or a missing API key fails open by default. The bot then behaves as it did before
the plugin. `failOpen: false` makes it answer mentions only.

Alternatives rejected:

- `before_agent_reply` with an empty reply. It runs later, after session resolution and
  workspace preparation, and its `cleanedBody` is the prepared prompt with channel context. The
  gate needs the raw message and should run before any of that work.
- `message_received` as the buffer feed. It is observe-only and fires on the same dispatch
  path, so it adds nothing over reading the message in `before_dispatch`.
- `@typesafe-ai/sdk` as a dependency. Version 0.6.0 was published two days before this change
  and the 7-day release cooldown refuses it. The plugin ships a small fetch client with the
  same request and response shapes.
- Installing `openclaw` for types. The package is 200 MB and pnpm auto-installs peers. The
  plugin keeps a local ambient module declaration for the handful of hook types it reads and
  sets `autoInstallPeers: false`.

The `before_dispatch` event does not carry `WasMentioned`. OpenClaw passes that flag only to
`inbound_claim`. The plugin therefore matches mentions itself, but with the host's patterns:
`api.runtime.channel.mentions.buildMentionRegexes(api.config, agentId)`. The assistant name
comes from `api.runtime.agent.resolveAgentIdentity`. Neither the event nor the context carries
an `agentId`, so the plugin parses it from the session key (`agent:<id>:...`) and falls back
to the default agent. Resolution runs per message because one gateway can host several agents
with different names. `assistantName` and `mentionPatterns` in the plugin config are optional
overrides on top of the host values.

## Feature switches and the model router

The plugin started as one feature. It now holds several Jev judgments around the agent, so the
config has one block per feature, each with `enabled`: `replyGate` (on by default, which keeps
the original behaviour) and `modelRouter` (off by default). Top-level keys are the ones every
feature shares: the assistant's name and description, `bufferSize`, and the TypeSafe connection.
The flat `threshold`, `mentionPatterns`, `evaluateDirectMessages` and `failOpen` keys moved
under `replyGate` with no compatibility shim; the plugin was unpublished when this changed.

`before_dispatch` and `message_sent` feed the conversation buffer whenever any feature is on,
so the router has conversation context even with the gate off. With every feature off the plugin
registers no hooks.

The model router uses `before_model_resolve`, which returns `providerOverride` and
`modelOverride` as separate fields. Jev answers two independent questions over one state: an
`effort` Score with four levels and a `highStakes` Noul. Code maps them to a light, standard or
heavy tier. Uncertainty goes to standard: a request only takes the light tier when Jev's
confidence in the effort score clears `minConfidence`. A tier with no model configured returns no
override, so the agent's own model stays in place.

Decisions made while building it:

- Two questions, not three. An intent Choice (chit-chat, lookup, coding, analysis) was dropped
  because no rule consumed it, and every question costs tokens.
- `heavyAbove` defaults to 0.8, not 0.67. With four levels, level 2 ("a task with a few steps")
  normalizes to exactly 0.667. A live check sent ordinary mid-sized tasks to the heavy tier at
  0.67. Fake-Jev unit tests could not have caught this.
- Only `user`-triggered runs are routed. Cron, heartbeat, memory and overflow runs carry the
  host's own prompts, which the questions are not written for.
- No default model names. A wrong id for a provider the user lacks would break runs, and with
  no tiers set the router becomes a log-only dry run.
- The router has no `failOpen`. On a Jev error the only sensible outcome is the agent's model.
  The host also wraps the hook in a try/catch and skips it when the model selection is locked.

## Files Modified

- `index.ts` — plugin entry through `definePluginEntry`.
- `openclaw.plugin.json` — manifest with config schema and UI hints.
- `package.json` — package metadata, `openclaw` peer, scripts.
- `src/plugin.ts` — hook wiring and decision order.
- `src/decide.ts` — Jev state, the three questions, the threshold rule.
- `src/route.ts` — model router: Jev state, the two questions, the tier rule.
- `src/buffer.ts` — per-conversation ring buffer with LRU eviction.
- `src/identity.ts` — agent id, name and mention resolution from the host config and runtime.
- `src/mention.ts` — extra mention patterns from the plugin config.
- `src/jev-client.ts` — client for `POST /v1/systemone`.
- `src/config.ts` — settings from plugin config and environment.
- `src/types/openclaw-plugin-sdk.d.ts` — ambient types for the SDK subset.
- `src/*.test.ts` — unit tests for each module.
- `Makefile`, `tsconfig*.json`, `pnpm-workspace.yaml`, `.gitignore`, `pnpm-lock.yaml`, `README.md` — project scaffold.

## Verification

- `make test` on final HEAD: 6 files, 24 tests, all passed. The
  tests cover the buffer ring and LRU, mention matching, the Jev client request and error
  handling, the state builder and threshold rule, and the hook wiring including mention
  bypass, direct-message bypass, silence below threshold, buffer feed from `message_sent`, and
  both failure policies.
- `make build`: `tsc` typecheck and emit passed.
- Bare `make` prints help.
- Not verified: a live gateway run. The plugin has not been linked into a running OpenClaw
  instance and no Jev call has been made against `api.typesafe.ai`.

## Follow-up

- Link the plugin into a gateway with a group channel and confirm the `before_dispatch`
  handler fires and silences a message.
- Replace `src/jev-client.ts` with `@typesafe-ai/sdk` after the cooldown passes.
- Tune the three questions and the threshold on real chat samples.
