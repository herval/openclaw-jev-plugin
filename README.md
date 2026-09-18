# openclaw-jev-gate

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that makes two decisions for your bot
before the language model runs: **should it answer this message**, and **which model should
answer it**. Both decisions come from [TypeSafe Jev](https://typesafe.ai), a model that returns
probabilities instead of text, so each one takes a fraction of a second.

## What it does

### Reply gate (on by default)

An OpenClaw bot in a group chat has two modes. With `requireMention: true` it answers only when
someone names it. With `requireMention: false` it answers every message, including the ones
people write to each other. The reply gate is the mode in between: the bot sees every message
and answers the ones meant for it.

| Message in a group chat | Without the gate | With the gate |
| --- | --- | --- |
| "@pato what broke the deploy?" | answers | answers (a mention always gets an answer) |
| "and what about staging?" right after the bot replied | answers | answers (a follow-up to the bot) |
| "anyone up for lunch?" | answers | stays silent |
| "thanks Ana, that fixed it" | answers | stays silent |

A silenced message never reaches the language model, so it costs one Jev call and no model
tokens. Direct messages always get an answer unless you choose to gate them too.

### Model router (off by default)

Most agents run one model for everything, so "thanks!" costs the same as "find the race
condition in this service". The router asks Jev how much work a request takes and whether a wrong
answer has consequences, then picks one of three models you configure:

| Request | Tier |
| --- | --- |
| "lol", "thanks, that worked", "what's the default Postgres port?" | **light** |
| "write a function that dedupes these users by email" | **standard** |
| "find the race, propose a fix with trade-offs, write the migration plan" | **heavy** |
| "what's the exact command to drop the production users table?" | **heavy**, because of the stakes |

When Jev is unsure, the request goes to **standard**, never to **light**. A tier you leave empty
keeps the agent's own model, so you only name the tiers you want to change. With no tiers set
the router only logs what it would have done.

More features are planned in [TODO.md](TODO.md). Each feature has its own `enabled` switch.

## What it sends to TypeSafe

The plugin sends chat content to `api.typesafe.ai`. Know what that covers before you enable it:

- **Reply gate:** the text of each group message, plus the last few messages of that conversation
  (8 by default, each cut to 400 characters) and the assistant's name and description. Direct
  messages are not sent unless `replyGate.evaluateDirectMessages` is on.
- **Model router:** the last 4000 characters of the prompt for every run a person triggered, in
  group chats and direct messages alike. The prompt can include history that OpenClaw adds.
  Because the router reads prompts, OpenClaw requires an explicit permission for it (see
  [Setup](#setup), step 5).

Nothing is sent for cron, heartbeat, memory or overflow runs. The API key is never logged.

If Jev is unreachable, slow or returns an error, the bot behaves as if the plugin were not
installed: the gate lets the message through (`replyGate.failOpen`), and the router keeps the
agent's model.

## Status

Prototype. The reply gate runs on a live gateway. The model router loads on a live gateway, and
its questions were checked against the live Jev API with nine prompts, but it has not yet routed
a real run. Unit tests cover the decision rules for both.

## Setup

1. **Install.** From a checkout of this repository:

   ```bash
   make setup
   make dev      # openclaw plugins install --link <this directory>, then enable
   ```

   A linked install loads the TypeScript source directly. OpenClaw's install scan stops at
   10,000 directories, so keep large checkouts out of this folder.

2. **Give it a TypeSafe API key.** Store the key in OpenClaw's secret store and point
   `config.apiKey` at it with a SecretRef. The gateway resolves the ref before the plugin loads,
   so the key never sits in `openclaw.json` and does not depend on the gateway's shell
   environment (a launchd service does not read `~/.zshrc`):

   ```bash
   openclaw config set plugins.entries.jev-gate.config.apiKey \
     '{"source":"store","provider":"default","id":"TYPESAFE_API_KEY"}' --json
   ```

   `config.apiKey` also accepts a plain string. With no `config.apiKey`, or a SecretRef that
   fails to resolve, the plugin falls back to `TYPESAFE_API_KEY` in the gateway environment. A
   failed ref logs a warning with its source and provider, never the value.

3. **Configure it** in `openclaw.json`. Only the description is worth setting for the gate:

   ```json5
   {
     plugins: {
       entries: {
         "jev-gate": {
           enabled: true,
           config: {
             assistantDescription: "The team's engineering helper. Answers questions about the monorepo and deploys.",
             replyGate: { enabled: true },
             modelRouter: {
               enabled: true,
               tiers: { light: "anthropic/claude-sonnet-4-6", standard: "anthropic/claude-sonnet-5" },
             },
           },
         },
       },
     },
   }
   ```

   Use model ids your gateway knows. `openclaw models list --all` prints them. An id the gateway
   cannot resolve would make every run on that tier fail.

4. **Let the gate see group messages.** Set `requireMention: false` on the group channels you
   want gated. With `requireMention: true`, OpenClaw drops unmentioned messages before they
   reach the plugin.

5. **Allow the router to read prompts.** Only needed when `modelRouter.enabled` is true. OpenClaw
   blocks the router's hook for any plugin it does not ship until you grant this:

   ```bash
   openclaw config set plugins.entries.jev-gate.hooks.allowConversationAccess true --json
   ```

   Without it the gateway logs `typed hook "before_model_resolve" blocked` and the router does
   nothing. The reply gate does not need this permission.

6. **Restart and check.** Run `openclaw gateway restart`, then look in the gateway log for:

   ```
   jev-gate: replyGate on, modelRouter on
   jev-gate: silent for <session> (addressed=0.05 wanted=0.20 audience=whole_group(0.99) threshold=0.6)
   jev-gate: route light -> anthropic/claude-sonnet-4-6 for <session> (effort=0.00(1.00) stakes=0.12)
   ```

## How the reply gate decides

1. OpenClaw runs the `before_dispatch` hook for every inbound message before the model runs.
2. The plugin appends the message to a per-conversation ring buffer (default 8 messages).
3. Direct messages pass through. A mention passes through. Mentions are matched with
   OpenClaw's own patterns for the agent that owns the session (see
   [Name and mentions](#name-and-mentions)), plus any extra patterns from the plugin config.
4. For everything else the plugin sends the buffer and the new message to Jev's
   `POST /v1/systemone` with three typed questions:
   - `addressedToAssistant` (yes/no): is the message for the assistant, or a follow-up to it?
   - `wantsAssistantReply` (yes/no): would the chat expect the assistant to answer now?
   - `audience` (choice): assistant, another person, the whole group, or nobody.
5. If `max(addressedToAssistant, wantsAssistantReply) >= replyGate.threshold` (default 0.6) the
   message continues to the model. Otherwise the hook returns `{ handled: true }` with no text,
   which ends the message silently.
6. The bot's own replies arrive through `message_sent` and are added to the buffer, so the next
   evaluation sees the exchange. Silenced messages stay in the buffer too, tagged
   `assistantAction: stayed_silent`, so Jev knows the bot has been quiet.

Jev returns calibrated probabilities instead of text, answers in well under a second, and does
not bill output tokens, so the gate is cheap enough to run on every group message.

## How the model router decides

1. OpenClaw runs the `before_model_resolve` hook once per agent run, before it picks a model.
2. The plugin sends Jev the end of the prompt (the current message sits last), the earlier
   messages from the buffer, and the kinds of any attachments, with two questions:
   - `effort` (score, 4 levels): from small talk, through a simple lookup and a task with a few
     steps, to a hard multi-step problem. Normalized to 0 to 1.
   - `highStakes` (yes/no): does a wrong answer carry real consequences?
3. Code maps the answers to a tier:
   - **heavy** when effort is at or above `heavyAbove`, or when stakes are high (0.7 or more) and
     the request is more than trivial.
   - **light** only when effort is at or below `lightBelow`, stakes are low (under 0.5), Jev's
     confidence in the effort score is at least `minConfidence`, and nothing is attached.
   - **standard** for everything else, which includes every uncertain case.
4. The tier's model is returned as the override. A tier with no model configured leaves the
   agent's own model in place.

Tier values are model references as OpenClaw writes them: `provider/model`, split on the first
slash, or a bare model id. If your agent already runs the expensive model, set `light` and
`standard` and leave `heavy` empty, so the router only ever moves a request to a cheaper model.

The router only looks at runs a person triggered. The host skips the hook when the model is
locked (for example with `/model`) and catches hook errors, so a Jev failure or timeout leaves
the agent's model in place.

Each decision is one Jev call of roughly 250 to 650 ms. The default thresholds come from a
nine-prompt check against the live API. Tune them on your own traffic.

## Name and mentions

The plugin reads the assistant's name and mention patterns from OpenClaw, so there is nothing
to repeat in the plugin config.

- The agent is taken from the session key (`agent:<id>:...`). A key without an agent falls
  back to the default agent. Two agents on one gateway each get their own name.
- The name is that agent's `identity.name`. With no identity it is `assistant`.
- Mentions use the host's `buildMentionRegexes`, which resolves patterns in this order: the
  agent's `groupChat.mentionPatterns`, then `messages.groupChat.mentionPatterns`, then
  patterns derived from `identity.name` and `identity.emoji`. The channel's `mentionPatterns`
  allow/deny policy applies too.

`assistantName` and `replyGate.mentionPatterns` in the plugin config remain as overrides. Set
`assistantName` when Jev should see a different name than the host identity. Set
`replyGate.mentionPatterns` to add patterns that only the gate should treat as a mention.

## Configuration

Top-level keys are shared. Each feature has its own block with an `enabled` switch.

| Key | Default | Meaning |
| --- | --- | --- |
| `assistantName` | agent `identity.name` | Overrides the name shown to Jev. Also counts as a mention. |
| `assistantDescription` | generic | What the assistant is for. Jev uses it to judge relevance. |
| `bufferSize` | `8` | Messages kept per conversation. Shared by every feature. |
| `replyGate.enabled` | `true` | Turns the reply gate on or off. |
| `replyGate.threshold` | `0.6` | Reply when Jev's probability is at or above this value. |
| `replyGate.mentionPatterns` | `[]` | Extra names or `/regex/i` strings that count as a mention, on top of the host's patterns. |
| `replyGate.evaluateDirectMessages` | `false` | Gate direct messages too. |
| `replyGate.failOpen` | `true` | On a Jev error or a missing key, reply (true) or stay silent (false). |
| `modelRouter.enabled` | `false` | Turns the model router on or off. |
| `modelRouter.tiers.light` | unset | Model for small talk and simple lookups. |
| `modelRouter.tiers.standard` | unset | Model for everyday requests and uncertain cases. |
| `modelRouter.tiers.heavy` | unset | Model for hard or high-stakes requests. |
| `modelRouter.lightBelow` | `0.34` | Effort at or below this can take the light tier. |
| `modelRouter.heavyAbove` | `0.8` | Effort at or above this takes the heavy tier. |
| `modelRouter.minConfidence` | `0.5` | Below this confidence, a request never takes the light tier. |
| `modelRouter.maxPromptChars` | `4000` | Characters of the prompt sent to Jev, counted from the end. |
| `apiKey` | env `TYPESAFE_API_KEY` | TypeSafe API key: a SecretRef or a plain string. |
| `baseUrl` | `https://api.typesafe.ai` | TypeSafe API root. |
| `model` | `jev-latest` | Jev model. |
| `timeoutMs` | `2500` | Per-request timeout. |

## Development

```bash
make test     # vitest
make build    # tsc typecheck + dist/
```

`src/types/openclaw-plugin-sdk.d.ts` types the subset of the OpenClaw plugin SDK the plugin
uses, so the 200 MB `openclaw` package is a peer dependency and is not installed here. The
gateway aliases `openclaw/plugin-sdk/*` to itself when it loads the plugin.

`src/jev-client.ts` is a 100-line client for `POST /v1/systemone` that mirrors
`@typesafe-ai/sdk` 0.6.0. The SDK was published on 2026-09-15, and the repository's 7-day
release cooldown refuses it. Replace the client with the SDK once the cooldown passes.

## Layout

```
index.ts                 plugin entry (definePluginEntry)
openclaw.plugin.json     manifest: config schema and UI hints
src/plugin.ts            hook wiring and feature switches
src/decide.ts            reply gate: Jev state, questions, decision rule
src/route.ts             model router: Jev state, questions, tier rule
src/buffer.ts            per-conversation ring buffer
src/identity.ts          agent, name and mention resolution from the host
src/mention.ts           extra mention patterns from the plugin config
src/jev-client.ts        HTTP client for Jev
src/config.ts            settings resolution
```
