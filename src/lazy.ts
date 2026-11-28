// Deferred module loading for a Cloudflare Worker. Every deferred load goes
// through `lazy()` / `withLazy()` - never a scattered bare `await import()` - and
// the rules in this package's `@curlewlabs-com/worker-lazy/eslint` entry
// enforce that.
//
// Why a primitive instead of bare `await import()`: the ES module registry
// already memoizes per isolate, so a second `import("./x.js")` reuses the cached
// namespace and never re-evaluates. But `await` on that cached promise still
// suspends to a microtask, warm included - so `await import(...)` written at
// every dispatch layer costs a microtask per layer per call, compounding along
// the call chain, the opposite of the zero-cost goal. `lazy()` caches the
// resolved namespace so the warm path is a plain synchronous value, and
// `withLazy()` is a non-async shell that calls straight through when warm (zero
// microtask) and only chains on the cold path.
//
// Cross-request constraint (safety invariant): the cold path caches the resolved
// module, NEVER the in-flight promise. Workers binds a promise to the I/O context
// of the request that created it, and a request awaiting a promise it did not
// create holds no pending work of its own - so the runtime sees an empty event
// loop with no Response returned and cancels it as hung, in single-digit
// milliseconds, while the request that created the promise completes normally.
// Sharing one load across concurrent cold callers therefore trades a promise
// allocation for a fail-closed hang on somebody else's request, and a shared
// in-flight promise has been seen doing exactly that on a live Worker. Deduping
// here also buys nothing: the module registry is what guarantees one evaluation,
// so a second `loader()` call attaches to the same evaluation rather than
// repeating it. Do not reintroduce an in-flight promise cache here. A promise slot
// inside a factory like `lazy()` below is correct-looking source text, so what
// guards this one is the each-cold-caller-gets-its-own-promise case in
// `test/lazy.test.ts`.
//
// Failure contract (safety invariant): a failed deferred load is a broken deploy -
// a demanded module is absent or its top-level threw, always an
// installation-correctness fault, never a transient data fault (the chunks ship
// inside the deployed artifact; there is no per-call fetch to flake). There is no
// user-mode recovery, exactly as there is none for a failed page-in, so the
// primitive does NOT hand back a catchable rejection that some upstack catch could
// swallow into a degraded result: it emits one structured diagnostic and then
// TERMINATES the isolate (`attemptToCrashTheIsolate`). The platform's next fresh
// isolate is the only retry, and a post-deploy check that reads the diagnostic
// can roll the deploy back.

import {
  TERMINATOR_TRAP_KEY,
  type TerminatorTrapSlot,
} from "./terminator-trap.ts";

export const LOAD_FAILURE_MARKER =
  "[deferred-load] reason=deferred_module_load_failed";
export const TERMINATING_MARKER = "[deferred-load] TERMINATING isolate";

// These fields are diagnostic only - they label the deferred-load failure log
// (below) so a broken-deploy load fault is easier to attribute; neither affects
// loading behavior. Both are facts about the declaration itself - which module
// this site loads, and which call site demanded it - so neither can be falsified
// by a change elsewhere in the import graph.
export type LazyLoadContext = {
  partition: string;
  operation: string;
};

function printableError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "<unprintable thrown value>";
  }
}

function errorStack(error: unknown): string {
  try {
    return error instanceof Error ? (error.stack ?? "") : "";
  } catch {
    return "<unreadable stack>";
  }
}

// Rooted for the isolate's remaining life so GC cannot reclaim the memory pressure
// `attemptToCrashTheIsolate` builds.
const crashAllocations: Uint8Array[] = [];

function allocateAndHold(size: number): void {
  const buffer = new Uint8Array(size);
  // Touch one byte per 4 KiB page: a zero-filled buffer may map lazily, but RSS
  // must actually grow to trip the isolate cap.
  for (let offset = 0; offset < size; offset += 4096) buffer[offset] = 1;
  crashAllocations.push(buffer);
}

// A deferred load failing is an installation-correctness fault with no user-mode
// recovery (see the failure contract in the file header), so the primitive
// terminates the isolate rather than returning a swallowable rejection. Workers
// gives application code no process-kill syscall and no thread to run a watchdog on
// (single-threaded; a synchronous spin starves anything scheduled), so the only
// forced-death lever is resource exhaustion: allocate rooted, page-touched buffers
// until RSS crosses the 128 MB isolate cap (the fast, isolate-wide kill), falling
// through to a CPU-limit spin once nothing more fits. Never returns, never awaits -
// the thread stays pinned so no catch/finally upstack can run.
export function attemptToCrashTheIsolate(reason: string): never {
  const trap = (globalThis as TerminatorTrapSlot)[TERMINATOR_TRAP_KEY];
  if (trap !== undefined) trap(reason);

  try {
    console.error(`${TERMINATING_MARKER} - ${reason}`);
  } catch {
    // A logging failure must never stop the crash from proceeding.
  }
  // Ramp big -> small so RSS keeps growing right up to the cap even as large
  // allocations start refusing near it; once even 1 byte will not fit, the bare
  // loop burns CPU to the same terminal end.
  for (;;) {
    for (let size = 1 << 20; size >= 1; size >>= 1) {
      for (;;) {
        try {
          allocateAndHold(size);
        } catch {
          break;
        }
      }
    }
  }
}

// An accessor over a lazily-loaded module: the module value once warm, or a
// promise of it on the first (cold) access.
export type Lazy<T> = () => T | Promise<T>;

// `lazy(loader, context)` returns an accessor that yields the loaded module
// synchronously once warm, and a promise only on the first (cold) access. The ES
// module registry stays the source of truth - this just caches the resolved
// namespace so the warm path is a plain value, not an `await`.
export function lazy<T>(
  loader: () => Promise<T>,
  context: LazyLoadContext,
): Lazy<T> {
  let mod: T | undefined;
  return () => {
    if (mod !== undefined) return mod;
    // Each cold caller starts its own `loader()` rather than sharing one in-flight
    // promise (see the cross-request constraint in the file header). The module
    // body still evaluates exactly once - that is the registry's guarantee, not
    // this cache's - so the cost of a concurrent cold access is one extra promise
    // and one extra `.then`, never a second evaluation.
    return loader().then(
      (m) => {
        mod = m;
        return m;
      },
      (err: unknown): never => {
        // A deferred load failing is a broken deploy, not a runtime fault - there
        // is no recovery and nothing upstack may swallow it, so we do not hand back
        // a rejection to await. Emit the diagnostic a post-deploy check reads
        // (synchronously, before the crash, so it lands in the invocation's log
        // buffer), then terminate the isolate.
        try {
          console.error(
            `${LOAD_FAILURE_MARKER} partition=${context.partition} operation=${context.operation} error=${JSON.stringify(printableError(err))} stack=${JSON.stringify(errorStack(err))}`,
          );
        } catch {
          // The diagnostic is best-effort; nothing that goes wrong while
          // writing it may stop the termination below.
        }
        return attemptToCrashTheIsolate(
          `partition=${context.partition} operation=${context.operation}`,
        );
      },
    );
  };
}

// A dispatch boundary (an entry handler, the router, a DO method) forwards into
// the loaded module and returns its result. `withLazy()` does that with no
// `await` on the warm path: it is a plain (non-async) function, so when warm it
// calls straight through and any result promise passes back untouched; only the
// cold path chains. An `async` shell that merely returned the inner promise
// would pay an extra adoption tick on every warm call - so the dispatch layers
// every request crosses stay non-async and route through here.
//
// The cold path's promise adopts a promise `use` returns, so its declared type is
// `Promise<Awaited<R>>`: a callback returning `Promise<Response>` makes the whole
// call `Promise<Response>`, which an `ExportedHandler`'s `fetch` accepts. The
// compiler cannot show that `then(use)` has that type for an unknown `R`, so the
// flattened type is the public signature and the implementation keeps its own.
export function withLazy<T, R>(
  l: Lazy<T>,
  use: (mod: T) => R,
): R | Promise<Awaited<R>>;
export function withLazy<T, R>(l: Lazy<T>, use: (mod: T) => R): R | Promise<R> {
  const m = l();
  return m instanceof Promise ? m.then(use) : use(m);
}
