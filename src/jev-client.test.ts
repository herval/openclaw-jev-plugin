import { describe, expect, it } from "vitest";
import { choice, createJevClient, JevError, noul } from "./jev-client.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("jev client", () => {
  it("posts state, questions and model with a bearer token", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const client = createJevClient({
      apiKey: "k",
      baseUrl: "https://example.test/",
      model: "jev-x",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(200, {
          model: "jev-x",
          answers: { yes: { type: "noul", noul: 0.9 } },
        });
      },
    });
    const result = await client.systemOne("state", { yes: noul("q?") });
    expect(result.answers.yes.noul).toBe(0.9);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.test/v1/systemone");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      state: "state",
      questions: { yes: { type: "noul", instructions: "q?" } },
      model: "jev-x",
    });
  });

  it("wraps non-2xx responses in JevError with status and request id", async () => {
    const client = createJevClient({
      apiKey: "k",
      fetch: async () =>
        jsonResponse(429, { error: "slow down" }, { "x-typesafe-request-id": "req-1" }),
    });
    const error = await client.systemOne("s", { a: choice("q", { x: null }) }).catch((e) => e);
    expect(error).toBeInstanceOf(JevError);
    expect(error.status).toBe(429);
    expect(error.requestId).toBe("req-1");
  });

  it("wraps transport failures and rejects empty question sets", async () => {
    const client = createJevClient({
      apiKey: "k",
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
    });
    await expect(client.systemOne("s", { a: noul("q") })).rejects.toThrow(/ECONNRESET/);
    await expect(client.systemOne("s", {})).rejects.toThrow(/at least one question/);
  });

  it("rejects a body without answers", async () => {
    const client = createJevClient({ apiKey: "k", fetch: async () => jsonResponse(200, { ok: true }) });
    await expect(client.systemOne("s", { a: noul("q") })).rejects.toThrow(/no answers/);
  });
});
