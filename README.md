# openclaw-jev-gate

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that decides whether the bot should
answer an incoming message. It keeps a small buffer of the last few messages per conversation
and asks [TypeSafe Jev](https://typesafe.ai) whether an answer is wanted. A mention always
gets an answer.

Status: prototype. Unit tests cover the decision logic. The plugin has not run
against a live gateway yet.

## How it works

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
5. If `max(addressedToAssistant, wantsAssistantReply) >= threshold` (default 0.6) the message
   continues to the model. Otherwise the hook returns `{ handled: true }` with no text, which
   ends the message silently.
6. The bot's own replies arrive through `message_sent` and are added to the buffer, so the next
   evaluation sees the exchange. Silenced messages stay in the buffer too, tagged
   `assistantAction: stayed_silent`, so Jev knows the bot has been quiet.

Jev returns calibrated probabilities instead of text, answers in well under a second, and does
not bill output tokens, so the gate is cheap enough to run on every group message.

## Install (local link)

```bash
make setup
make dev      # openclaw plugins install --link ... && enable
```

Then in `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "jev-gate": {
        enabled: true,
        config: {
          assistantDescription: "The team's engineering helper. Answers questions about the monorepo and deploys.",
          threshold: 0.6,
          bufferSize: 8,
        },
      },
    },
  },
}
```

Store the TypeSafe key in OpenClaw's secret store and point `config.apiKey` at it with a
SecretRef. The gateway resolves the ref before the plugin loads, so the key never sits in
`openclaw.json` and does not depend on the gateway's shell environment (launchd does not read
`~/.zshrc`):

```bash
openclaw config set plugins.entries.jev-gate.config.apiKey \
  '{"source":"store","provider":"default","id":"TYPESAFE_API_KEY"}' --json
```

`config.apiKey` also accepts a plain string. With no `config.apiKey`, or a SecretRef that fails
to resolve, the plugin falls back to `TYPESAFE_API_KEY` in the gateway environment. A failed ref
logs a warning with its source and provider, never the value.

The gate only matters for group channels where OpenClaw delivers every message. Keep the
channel's `requireMention: false` for the groups you want gated. Channels that already run
with `requireMention: true` never reach the gate for unmentioned messages.

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

`assistantName` and `mentionPatterns` in the plugin config remain as overrides. Set
`assistantName` when Jev should see a different name than the host identity. Set
`mentionPatterns` to add patterns that only the gate should treat as a mention.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `assistantName` | agent `identity.name` | Overrides the name shown to Jev. Also counts as a mention. |
| `assistantDescription` | generic | What the assistant is for. Jev uses it to judge relevance. |
| `mentionPatterns` | `[]` | Extra names or `/regex/i` strings that count as a mention, on top of the host's patterns. |
| `threshold` | `0.6` | Reply when Jev's probability is at or above this value. |
| `bufferSize` | `8` | Messages kept per conversation. |
| `evaluateDirectMessages` | `false` | Gate direct messages too. |
| `failOpen` | `true` | On a Jev error or a missing key, reply (true) or stay silent (false). |
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
src/plugin.ts            hook wiring: before_dispatch, message_sent
src/decide.ts            Jev state, questions, decision rule
src/buffer.ts            per-conversation ring buffer
src/identity.ts          agent, name and mention resolution from the host
src/mention.ts           extra mention patterns from the plugin config
src/jev-client.ts        HTTP client for Jev
src/config.ts            settings resolution
```
