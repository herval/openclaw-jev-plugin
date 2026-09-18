/**
 * Minimal client for TypeSafe Jev's `POST /v1/systemone`.
 *
 * Mirrors the request and response shapes of `@typesafe-ai/sdk` 0.6.0 (see the
 * SDK's `types.d.ts`). The SDK itself is not a dependency: it was published two
 * days before this plugin and the repository's 7-day release cooldown refuses it.
 * Swapping this file for the SDK is a one-file change.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type EntryType = string | { [key: string]: JsonValue } | JsonValue[] | null;

export type NoulQuestion = {
  type: "noul";
  instructions?: EntryType;
  criteria?: { true?: EntryType; false?: EntryType } | null;
};

export type ChoiceQuestion<T extends Record<string, EntryType> = Record<string, EntryType>> = {
  type: "choice";
  instructions?: EntryType;
  criteria: T;
};

/** Ordered levels, low to high. 2 to 10 entries; each must describe a situation that stands on its own. */
export type ScoreQuestion = {
  type: "score";
  instructions?: EntryType;
  criteria: readonly EntryType[];
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export type NoulResponse = { type: "noul"; noul: number };
export type ChoiceResponse<T extends Record<string, EntryType> = Record<string, EntryType>> = {
  type: "choice";
  choice: keyof T & string;
  confidence: number;
  probabilities: { [label in keyof T]: number };
};

export type ScoreResponse = {
  type: "score";
  /** Probability-weighted level, from 0 to the highest level index. */
  score: number;
  confidence: number;
  /** Probability per level, keyed by the level index as a string. */
  probabilities: Record<string, number>;
};

export type ResultFor<Q extends Question> = Q extends NoulQuestion
  ? NoulResponse
  : Q extends ScoreQuestion
    ? ScoreResponse
    : Q extends ChoiceQuestion<infer T>
      ? ChoiceResponse<T>
      : never;

export type SystemOneResult<Q extends Questions> = {
  model: string;
  answers: { [K in keyof Q]: ResultFor<Q[K]> };
  usage?: { input_tokens: number; output_tokens: number };
};

export const noul = (instructions: EntryType, criteria?: NoulQuestion["criteria"]): NoulQuestion => ({
  type: "noul",
  instructions,
  ...(criteria ? { criteria } : {}),
});

export const choice = <const T extends Record<string, EntryType>>(
  instructions: EntryType,
  criteria: T,
): ChoiceQuestion<T> => ({ type: "choice", instructions, criteria });

export const score = (instructions: EntryType, criteria: readonly EntryType[]): ScoreQuestion => ({
  type: "score",
  instructions,
  criteria,
});

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type JevClientOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: Fetch;
};

export type JevClient = {
  systemOne<const Q extends Questions>(
    state: EntryType,
    questions: Q,
    options?: { signal?: AbortSignal },
  ): Promise<SystemOneResult<Q>>;
};

export class JevError extends Error {
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  constructor(message: string, options?: { status?: number; requestId?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "JevError";
    this.status = options?.status;
    this.requestId = options?.requestId;
  }
}

function joinSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return AbortSignal.any([a, b]);
}

export function createJevClient(options: JevClientOptions): JevClient {
  const baseUrl = (options.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, "");
  const model = options.model ?? "jev-latest";
  const timeoutMs = options.timeoutMs ?? 2500;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new JevError("No fetch implementation available");
  }

  return {
    async systemOne(state, questions, callOptions) {
      if (Object.keys(questions).length === 0) {
        throw new JevError("systemOne needs at least one question");
      }
      const signal = joinSignals(AbortSignal.timeout(timeoutMs), callOptions?.signal);
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "openclaw-jev-gate/0.1.0",
          },
          body: JSON.stringify({ state, questions, model }),
          signal,
        });
      } catch (error) {
        throw new JevError(`Jev request failed: ${describe(error)}`, { cause: error });
      }
      const requestId = response.headers.get("x-typesafe-request-id") ?? undefined;
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }
      if (!response.ok) {
        throw new JevError(`Jev responded ${response.status}: ${summarize(parsed)}`, {
          status: response.status,
          requestId,
        });
      }
      if (!parsed || typeof parsed !== "object" || !("answers" in parsed)) {
        throw new JevError("Jev response has no answers", { status: response.status, requestId });
      }
      return parsed as SystemOneResult<typeof questions>;
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "timeout" : error.message;
  }
  return String(error);
}

function summarize(body: unknown): string {
  if (typeof body === "string") {
    return body.slice(0, 200);
  }
  try {
    return JSON.stringify(body).slice(0, 200);
  } catch {
    return "unreadable body";
  }
}
