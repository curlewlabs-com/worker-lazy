import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  attemptToCrashTheIsolate,
  lazy,
  LOAD_FAILURE_MARKER,
  withLazy,
} from "../src/lazy.ts";
import {
  TERMINATOR_TRAP_KEY,
  type TerminatorTrapSlot,
} from "../src/terminator-trap.ts";
import {
  DeferredLoadTerminated,
  installTerminatorTrap,
} from "../src/testing.ts";

// These tests pin the contract the primitive exists for: the warm path is a plain
// synchronous value (no per-call microtask), each concurrent cold caller gets its
// own promise while still resolving to one module value (the cross-request
// constraint in src/lazy.ts's header), and a FAILED load is a broken deploy that
// TERMINATES the isolate - it does not hand back a swallowable rejection to
// recover from. Every failure test installs a throwing terminator trap so
// termination is observable without exhausting the test process.

function throwingTrap(onReason: (reason: string) => void): () => void {
  return installTerminatorTrap((reason) => {
    onReason(reason);
    throw new DeferredLoadTerminated(reason);
  });
}

function silenceConsoleError() {
  return mock.method(console, "error", () => {});
}

function loggedLines(spy: ReturnType<typeof silenceConsoleError>): string[] {
  return spy.mock.calls.map((c) => String(c.arguments[0]));
}

const TEST_CONTEXT = {
  partition: "test-partition",
  operation: "test.operation",
} as const;

describe("lazy", () => {
  it("returns a promise on cold access and loads once", async () => {
    const mod = { value: 42 };
    let calls = 0;
    const load = lazy(() => {
      calls++;
      return Promise.resolve(mod);
    }, TEST_CONTEXT);

    const cold = load();
    assert.ok(cold instanceof Promise);
    assert.equal(await cold, mod);
    assert.equal(calls, 1);
  });

  it("returns the module synchronously once warm (no await)", async () => {
    const mod = { value: 42 };
    const load = lazy(() => Promise.resolve(mod), TEST_CONTEXT);

    await load();

    const warm = load();
    assert.ok(!(warm instanceof Promise));
    assert.equal(warm, mod);
  });

  // Guards the cross-request constraint in the lazy.ts header. On Workers a
  // promise belongs to the I/O context of the request that created it, so handing
  // one concurrent cold caller another's promise leaves the adopter with no
  // pending work and the runtime cancels it as hung. Each cold caller must
  // therefore get a promise of its own. Asserted as distinct identities rather
  // than by racing requests, because identity is the property the invariant
  // actually rests on and it holds without a live isolate to schedule against.
  it("gives each concurrent cold caller its own promise", async () => {
    // Each cold call gets its own resolver, so they are collected rather than
    // captured into one binding - overwriting a single binding would leave the
    // first caller's promise pending forever, which is the shape this test exists
    // to distinguish from sharing.
    const resolvers: ((m: { v: number }) => void)[] = [];
    const load = lazy(
      () =>
        new Promise<{ v: number }>((res) => {
          resolvers.push(res);
        }),
      TEST_CONTEXT,
    );

    const a = load();
    const b = load();
    assert.notEqual(a, b);
    assert.equal(resolvers.length, 2);

    const mod = { v: 1 };
    for (const res of resolvers) res(mod);
    assert.equal(await a, mod);
    assert.equal(await b, mod);
  });

  // The companion half: not sharing the promise must not cost a second module
  // evaluation. Real loaders are `() => import(...)`, where the module registry
  // collapses repeat calls onto one evaluation; this stands in for that with a
  // loader that memoizes its own result, so a regression that made the accessor
  // re-evaluate per caller would surface as distinct module values.
  it("resolves every cold caller to one module value", async () => {
    const mod = { v: 1 };
    let evaluations = 0;
    const registry = () => {
      evaluations++;
      return mod;
    };
    let settle!: () => void;
    const gate = new Promise<void>((res) => {
      settle = res;
    });
    let evaluated: { v: number } | undefined;
    const load = lazy(
      () => gate.then(() => (evaluated ??= registry())),
      TEST_CONTEXT,
    );

    // Started together, then awaited one by one: the accessor's return type is
    // `T | Promise<T>`, which is not an iterable of thenables the promise
    // aggregators accept.
    const callers = [load(), load(), load()];
    settle();
    for (const caller of callers) assert.equal(await caller, mod);

    assert.equal(evaluations, 1);
    assert.equal(load(), mod);
  });

  it("crashes the isolate on a failed load instead of returning a recoverable rejection", async () => {
    // A missing or broken chunk is an installation fault, not a runtime data
    // fault: the primitive terminates rather than surfacing a rejection some
    // upstack catch could swallow into a degraded result.
    let terminatorCalls = 0;
    let capturedReason = "";
    const restore = throwingTrap((reason) => {
      terminatorCalls++;
      capturedReason = reason;
    });
    const errorSpy = silenceConsoleError();
    try {
      const err = new Error("chunk unavailable");
      err.stack = "stack-marker";
      const load = lazy<{ v: number }>(() => Promise.reject(err), TEST_CONTEXT);

      await assert.rejects(load() as Promise<unknown>, DeferredLoadTerminated);
      assert.equal(terminatorCalls, 1);
      assert.match(capturedReason, /operation=test\.operation/);

      // The diagnostic carries the loader's own error and stack, emitted
      // synchronously before the crash - and only that one line (the trap fires
      // before attemptToCrashTheIsolate's own "TERMINATING" line).
      const lines = loggedLines(errorSpy);
      assert.equal(lines.length, 1);
      const line = lines[0] ?? "";
      assert.ok(line.startsWith(`${LOAD_FAILURE_MARKER} `));
      assert.ok(line.includes("partition=test-partition"));
      assert.ok(line.includes("operation=test.operation"));
      assert.ok(line.includes('error="chunk unavailable"'));
      assert.ok(line.includes('stack="stack-marker"'));
    } finally {
      errorSpy.mock.restore();
      restore();
    }
  });

  it("terminates every concurrent cold caller without dispatching", async () => {
    // The safety property is that no caller escapes termination into dispatch -
    // a broken deploy must not reach handler code on any path. Each cold caller
    // runs its own loader (the cross-request constraint), so each failure
    // terminates independently. A real isolate still emits exactly one
    // diagnostic: attemptToCrashTheIsolate never returns, so the first handler to
    // reach it pins the single thread and no later microtask runs. The trap
    // throws instead of pinning, which is the only reason the second is
    // observable here.
    let terminatorCalls = 0;
    const restore = throwingTrap(() => {
      terminatorCalls++;
    });
    const errorSpy = silenceConsoleError();
    try {
      const err = new Error("chunk unavailable");
      let uses = 0;
      const load = lazy<{ value: number }>(
        () => Promise.reject(err),
        TEST_CONTEXT,
      );

      const first = withLazy(load, () => uses++);
      const second = withLazy(load, () => uses++);

      await assert.rejects(first as Promise<unknown>, DeferredLoadTerminated);
      await assert.rejects(second as Promise<unknown>, DeferredLoadTerminated);
      assert.equal(uses, 0);
      assert.equal(terminatorCalls, 2);
      const lines = loggedLines(errorSpy);
      assert.equal(lines.length, 2);
      for (const line of lines) {
        assert.ok(line.startsWith(`${LOAD_FAILURE_MARKER} `));
      }
    } finally {
      errorSpy.mock.restore();
      restore();
    }
  });

  it("logs a frozen loader failure's message before terminating", async () => {
    // The diagnostic must read a non-extensible thrown value without itself
    // throwing, on the path to the crash.
    const restore = installTerminatorTrap();
    const errorSpy = silenceConsoleError();
    try {
      const frozenFailure = Object.freeze(new Error("chunk unavailable"));
      const load = lazy(() => Promise.reject(frozenFailure), TEST_CONTEXT);

      await assert.rejects(load() as Promise<unknown>, DeferredLoadTerminated);
      const lines = loggedLines(errorSpy);
      assert.equal(lines.length, 1);
      assert.ok((lines[0] ?? "").includes('error="chunk unavailable"'));
    } finally {
      errorSpy.mock.restore();
      restore();
    }
  });

  it("terminates on a rejection value that cannot be inspected", async () => {
    // `instanceof` on a revoked Proxy throws. If reading the value for the
    // diagnostic threw on the path to the crash, the accessor would reject with
    // that TypeError and a caller could catch a failed load.
    let terminatorCalls = 0;
    const restore = throwingTrap(() => {
      terminatorCalls++;
    });
    const errorSpy = silenceConsoleError();
    try {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a reason that cannot be inspected is what this test covers
      const load = lazy(() => Promise.reject(proxy), TEST_CONTEXT);

      await assert.rejects(load() as Promise<unknown>, DeferredLoadTerminated);
      assert.equal(terminatorCalls, 1);
      const line = loggedLines(errorSpy)[0] ?? "";
      assert.ok(line.includes('error="<unprintable thrown value>"'));
      assert.ok(line.includes('stack="<unreadable stack>"'));
    } finally {
      errorSpy.mock.restore();
      restore();
    }
  });

  it("terminates when writing the diagnostic throws", async () => {
    // The diagnostic is best-effort: a console that throws must not turn a
    // failed load into a rejection a caller could catch.
    let terminatorCalls = 0;
    const restore = throwingTrap(() => {
      terminatorCalls++;
    });
    const errorSpy = mock.method(console, "error", () => {
      throw new Error("console unavailable");
    });
    try {
      const load = lazy(
        () => Promise.reject(new Error("chunk unavailable")),
        TEST_CONTEXT,
      );

      await assert.rejects(load() as Promise<unknown>, DeferredLoadTerminated);
      assert.equal(terminatorCalls, 1);
    } finally {
      errorSpy.mock.restore();
      restore();
    }
  });
});

describe("attemptToCrashTheIsolate", () => {
  it("uses the installed trap and restores the previous one", (t) => {
    // A test-specific trap must restore any trap installed by suite setup.
    const previousError = new Error("suite trap");
    t.after(
      installTerminatorTrap(() => {
        throw previousError;
      }),
    );
    let seen = "";
    const restore = throwingTrap((reason) => {
      seen = reason;
    });
    try {
      assert.throws(
        () => attemptToCrashTheIsolate("boom"),
        DeferredLoadTerminated,
      );
      assert.equal(seen, "boom");
    } finally {
      restore();
    }

    // Fail without entering real termination if restore cleared the slot.
    assert.ok((globalThis as TerminatorTrapSlot)[TERMINATOR_TRAP_KEY]);
    assert.throws(
      () => attemptToCrashTheIsolate("after restore"),
      (error) => error === previousError,
    );
  });
});

describe("withLazy", () => {
  it("runs `use` synchronously on the warm path, before any queued microtask", async () => {
    const mod = { value: 42 };
    const load = lazy(() => Promise.resolve(mod), TEST_CONTEXT);
    await load();

    const order: string[] = [];
    // A microtask queued *before* the warm dispatch: if withLazy suspended even
    // one microtask, "microtask" would land before "use".
    void Promise.resolve().then(() => order.push("microtask"));

    const r = withLazy(load, (m) => {
      order.push("use");
      return m.value * 2;
    });

    assert.equal(r, 84);
    assert.deepEqual(order, ["use"]);
  });

  it("chains on the cold path and yields the used result", async () => {
    const mod = { value: 42 };
    const load = lazy(() => Promise.resolve(mod), TEST_CONTEXT);

    const r = withLazy(load, (m) => m.value);
    assert.ok(r instanceof Promise);
    assert.equal(await r, 42);
  });

  it("types an async callback's cold result as one promise, as a handler declares it", async () => {
    // A Worker's typed `fetch` returns `Response | Promise<Response>`. The cold
    // path adopts the callback's promise, so a shell returning withLazy() over
    // an async handler must type-check against that; `npm run typecheck`
    // carries this half of the test.
    const load = lazy(
      () => Promise.resolve({ handle: async () => new Response("ok") }),
      TEST_CONTEXT,
    );
    const shell: { fetch(): Response | Promise<Response> } = {
      fetch() {
        return withLazy(load, (m) => m.handle());
      },
    };

    const cold = await shell.fetch();
    assert.equal(await cold.text(), "ok");
  });

  it("does not classify or crash on a failure thrown by the dispatched handler", async () => {
    // A `use` throw is a runtime fault, not a load failure - it propagates
    // normally (no terminate, no diagnostic), so a handler bug stays an ordinary
    // exception.
    let terminatorCalls = 0;
    const restore = throwingTrap(() => {
      terminatorCalls++;
    });
    const errorSpy = silenceConsoleError();
    try {
      const handlerError = new Error("handler failed");
      const load = lazy(() => Promise.resolve({ value: 42 }), TEST_CONTEXT);
      await load();

      assert.throws(
        () =>
          withLazy(load, () => {
            throw handlerError;
          }),
        (e) => e === handlerError,
      );
      assert.equal(terminatorCalls, 0);
      assert.equal(errorSpy.mock.callCount(), 0);
      assert.deepEqual(load(), { value: 42 });
    } finally {
      errorSpy.mock.restore();
      restore();
    }
  });
});
