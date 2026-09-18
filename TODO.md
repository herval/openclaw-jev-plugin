# TODO

Jev features to add next. Each one is a hook that can change the outcome, a few typed questions
over one state, and a rule in code that turns the probabilities into an action. Each gets its own
config block with an `enabled` switch, off by default, next to `replyGate` and `modelRouter`.

Hook contracts below were read from the OpenClaw source. Check them against the installed
gateway's `dist/*.d.ts` before building, as the model router did.

## Tool-call approval gate (`toolGate`)

- **Hook:** `before_tool_call`. It can return `block` with a `blockReason`, rewrite `params`, or
  return `requireApproval` with a title, description and severity.
- **Questions:** a Noul for "is this action destructive or hard to undo?", a Noul for "does this
  action match what the person asked for in the conversation?", and a Score for blast radius.
- **Rule:** routine calls pass, risky calls pause for a person, calls nobody asked for are blocked.
- **Why:** OpenClaw agents run real shell and Slack actions, so this is the highest-value safety
  feature.
- **Watch for:** a threshold set too tight makes the bot ask for approval constantly. Start in a
  log-only mode, as the router does with no tiers set.

## Outbound reply check (`replyCheck`)

- **Hooks:** `message_sending` can `cancel` a message or rewrite its `content`.
  `before_agent_finalize` can return `revise` with a retry instruction, which forces another
  model pass.
- **Questions:** Nouls such as "answers the question that was asked", "reveals something from
  another channel, or a secret", and "tone suits a public group".
- **Rule:** a failing check asks for a revision instead of sending. Cap the retries.
- **Why:** TypeSafe's verification pattern, pointed at the bot's own output.
- **Read first:** the [LLM guardrails cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails.md).

## Context selection (`contextPicker`)

- **Hook:** `before_prompt_build` can set `prependContext` and `appendContext`.
- **How:** code collects candidates (memory notes, pinned docs, older thread messages). A
  relevance Score per candidate picks the few worth adding.
- **Why:** smaller prompts and better grounding.
- **Cost:** the most plumbing of the four, because it needs a candidate source first.
- **Read first:** the [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md).

## A richer reply gate

- **How:** the gate already calls Jev on every group message. Independent questions over the same
  state run in parallel, so extra signals add no latency. Candidates: urgency, "a question nobody
  has answered for N minutes", sentiment.
- **Rule ideas:** an unanswered question lowers the reply threshold. Urgency feeds the model
  router's tier, which would save the router its own Jev call.
- **Constraint:** extra questions still cost tokens. Add only the ones a rule consumes.

## Housekeeping

- The plugin id is still `jev-gate`, though it is no longer only a gate. Renaming changes the
  config key and needs a reinstall, so do it before publishing or not at all.
- `npm pack` produces a package the gateway refuses, because `dist/` is gitignored and a packaged
  install needs compiled JavaScript. Add a `files` allowlist that includes `dist/`.
- Replace `src/jev-client.ts` with `@typesafe-ai/sdk` once the release cooldown has passed.
