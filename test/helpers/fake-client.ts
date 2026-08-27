/**
 * A {@link YnabClient} backed by canned responses instead of the network. The
 * SDK is reached only as `client.api.<group>.<method>(...)`, so a proxy can
 * stand in for the whole of it without naming the parts each tool happens to
 * use. See AGENTS.md, "The client module".
 */
import type { YnabApi, YnabClient } from "../../src/client.ts";

/** What a faked call does: return a body, or throw one. */
export type Reply = { readonly data: unknown } | { readonly throws: unknown };

/** Canned replies, keyed `"group.method"` — `"transactions.getTransactions"`. */
export type Replies = Readonly<Record<string, Reply>>;

/** One call a tool made, in the order it made it. */
export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface FakeClient extends YnabClient {
  /** Every SDK call the tools made, in order. */
  readonly calls: readonly RecordedCall[];
  /** The single call made, asserting there was exactly one. */
  onlyCall(): RecordedCall;
}

/** The YNAB error body shape, which the SDK throws as a plain object. */
export function ynabError(id: string, name: string, detail: string): { throws: unknown } {
  return { throws: { error: { id, name, detail } } };
}

/**
 * Build a client whose every SDK call is looked up in `replies`. An unlisted
 * call throws rather than returning undefined: a tool reaching for an endpoint
 * the test did not anticipate is a fact worth failing on.
 */
export function fakeClient(replies: Replies = {}, planId = "plan-1"): FakeClient {
  const calls: RecordedCall[] = [];

  const api = new Proxy(
    {},
    {
      get(_target, group: string) {
        return new Proxy(
          {},
          {
            get(_inner, method: string) {
              const key = `${group}.${method}`;
              return (...args: unknown[]) => {
                calls.push({ method: key, args });
                const reply = replies[key];
                if (reply === undefined) {
                  throw new Error(
                    `fakeClient: no reply configured for \`${key}\`. Calls so far: ` +
                      `${calls.map((call) => call.method).join(", ")}`,
                  );
                }
                if ("throws" in reply) return Promise.reject(reply.throws);
                return Promise.resolve({ data: reply.data });
              };
            },
          },
        );
      },
    },
  ) as YnabApi;

  return {
    api,
    resolvePlanId: (given?: string) => given?.trim() || planId,
    calls,
    onlyCall() {
      if (calls.length !== 1) {
        throw new Error(`expected exactly one SDK call, got ${calls.length}: ${describe(calls)}`);
      }
      const [call] = calls;
      if (call === undefined) throw new Error("unreachable");
      return call;
    },
  };
}

function describe(calls: readonly RecordedCall[]): string {
  return calls.length === 0 ? "none" : calls.map((call) => call.method).join(", ");
}
