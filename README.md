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
3. Direct messages pass through. A mention of the assistant name or any configured pattern
   passes through.
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
          assistantName: "pato",
          assistantDescription: "The team's engineering helper. Answers questions about the monorepo and deploys.",
          mentionPatterns: ["@pato", "/\\bduck\\b/"],
          threshold: 0.6,
          bufferSize: 8,
        },
      },
    },
  },
}
```

Export `TYPESAFE_API_KEY` in the gateway environment. The plugin reads it, then falls back to
`config.apiKey`.

The gate only matters for group channels where OpenClaw delivers every message. Keep the
channel's `requireMention: false` for the groups you want gated. Channels that already run
with `requireMention: true` never reach the gate for unmentioned messages.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `assistantName` | `assistant` | Name used for mention detection and shown to Jev. |
| `assistantDescription` | generic | What the assistant is for. Jev uses it to judge relevance. |
| `mentionPatterns` | `[]` | Extra names or `/regex/i` strings that count as a mention. |
| `threshold` | `0.6` | Reply when Jev's probability is at or above this value. |
| `bufferSize` | `8` | Messages kept per conversation. |
| `evaluateDirectMessages` | `false` | Gate direct messages too. |
| `failOpen` | `true` | On a Jev error or a missing key, reply (true) or stay silent (false). |
| `apiKey` | env `TYPESAFE_API_KEY` | TypeSafe API key. |
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
src/mention.ts           mention patterns
src/jev-client.ts        HTTP client for Jev
src/config.ts            settings resolution
```
