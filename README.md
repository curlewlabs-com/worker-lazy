# worker-lazy

Deferred module loading for Cloudflare Workers: a `lazy()` primitive that loads
a module on first use and costs nothing once it is loaded, and ESLint rules
that keep a Worker's startup module graph down to what the Worker actually
needs before it can serve a request.

## What it is

One package with two entries that never meet:

- `@curlewlabs-com/worker-lazy` - the runtime primitive.
  `lazy(loader, context)` returns an accessor for a module that is loaded the
  first time the accessor is called; `withLazy(accessor, use)` calls into that
  module. No dependencies; the entry bundles to under a kilobyte minified.
- `@curlewlabs-com/worker-lazy/eslint` - an ESLint plugin with three rules that
  make deferral the default: a static import has to defer through `lazy()` or
  say why it cannot, a dynamic `import()` is allowed only as a `lazy()` loader,
  and the Worker's entry handlers stay synchronous so the loaded path adds no
  microtask. A fourth rule keeps a request from awaiting a promise that
  another request created. A Worker that imports the primitive bundles none of
  the lint.

## Why it exists

A Worker isolate evaluates every module reachable through static imports from
its entry before it handles the first request. In a large Worker, most of that
code serves routes or jobs a given isolate never runs, and the isolate still
pays CPU and memory to evaluate it. Bundlers split code at dynamic `import()`,
so the fix is to reach most modules dynamically - but doing that by hand has
three problems this package addresses.

**`await import()` is not free when warm.** The module registry caches a loaded
module, so a second `import("./x.js")` does not evaluate it again. But `await`
on the cached promise still suspends for a microtask, and a request that crosses
several dispatch layers pays one per layer on every request. `lazy()` keeps the
loaded module itself, so once warm the accessor returns a plain value, and
`withLazy()` is an ordinary function that calls straight through without
creating a promise. Only the first, cold call is asynchronous.

**Sharing a load between requests can hang one of them.** The obvious
optimization - cache the in-flight promise so concurrent cold callers share
one load - is wrong on Workers. A promise belongs to the request that created
it; a second request that awaits it has no pending work of its own, and the
runtime cancels that request as hung. `lazy()` gives every cold caller its own
promise. The registry still evaluates the module once, so this costs one extra
promise, never a second evaluation. The same optimization is just as tempting
anywhere else a Worker loads or refreshes something - a token, a key, a
config - and fails the same way, on some later request rather than the one
that introduced it, so one of the rules looks for its module-scope form.

**A failed load must not degrade quietly.** The deferred chunks ship inside
the deployed bundle, so a load that fails means the deploy is broken - a chunk
is missing or its top level threw - not that something transient went wrong.
A rejection that some `catch` further up turns into a fallback response would
hide that. So `lazy()` logs one structured line and then ends the isolate (see
[Ending the isolate](#ending-the-isolate)); the platform's next isolate is the
retry, and a deploy check can read the line and roll back.

Conventions like "defer everything" erode one convenient static import at a
time, so the rules come with the primitive.

## How to use it

This package is not published to the npm registry. Install it from a GitHub
release's tarball URL, which your lockfile pins by its integrity hash:

```sh
npm install https://github.com/curlewlabs-com/worker-lazy/releases/download/v0.2.1/curlewlabs-com-worker-lazy-0.2.1.tgz
```

Each release's notes give its tarball's SHA-512 integrity, and the tarball has
a GitHub build provenance attestation
(`gh attestation verify <file> -R curlewlabs-com/worker-lazy`).

### The primitive

Keep the entry module small and reach each handler through `lazy()`:

```ts
// src/index.ts - the only module every isolate evaluates
import { lazy, withLazy } from "@curlewlabs-com/worker-lazy";

const api = lazy(() => import("./api.js"), {
  partition: "api",
  operation: "fetch",
});
const jobs = lazy(() => import("./jobs.js"), {
  partition: "jobs",
  operation: "scheduled",
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return withLazy(api, (m) => m.handleFetch(request, env, ctx));
  },
  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    return withLazy(jobs, (m) => m.handleScheduled(event, env, ctx));
  },
};
```

Declare each accessor once, at module scope, and use it wherever that module
is needed; the same pattern works inside `api.js` for its own routes. A Durable
Object class works the same way: the class stays in a small module, and each
method returns `withLazy(...)` into the module that holds its body.

- `lazy(loader, context)` - `loader` is `() => import("./relative.js")`.
  `context` is required and only labels the failure line: `partition` names the
  module this accessor loads, `operation` the call site that needs it. Neither
  changes how anything loads.
- `withLazy(accessor, use)` - returns `use(module)` directly when the module is
  loaded, or a promise of it on the cold call.
- The accessor itself returns the module, or a promise of it on the cold call.

When a load fails, `lazy()` writes one line with `console.error` and then ends
the isolate:

```text
[deferred-load] reason=deferred_module_load_failed partition=api operation=fetch error="..." stack="..."
```

### Ending the isolate

`attemptToCrashTheIsolate(reason)` is exported for code that, like a failed
load, has found the isolate itself unusable - state that cannot be trusted for
any later request - and needs it gone rather than serving on. Workers gives
application code no way to kill an isolate and no second thread, so the only
lever is resource exhaustion: it logs `[deferred-load] TERMINATING isolate -
<reason>`, then allocates and touches memory until the isolate passes the
platform's 128 MB memory limit, and falls through to spinning against the CPU
limit if allocation stops succeeding. It never returns and never awaits, so no
`catch` or `finally` above it runs. Use it only where serving a degraded result
would be worse than failing every request on that isolate.

### Testing a load failure

The real failure path would exhaust the test process, so a test installs a
replacement first. Set `globalThis.__deferredLoadTerminatorForTest` to a
function that throws, and `attemptToCrashTheIsolate` calls it instead of
allocating:

```ts
globalThis.__deferredLoadTerminatorForTest = (reason) => {
  throw new Error(`terminated: ${reason}`);
};
// ...exercise a lazy() whose loader rejects, expect that error...
delete globalThis.__deferredLoadTerminatorForTest;
```

It is read from `globalThis` rather than a module binding so it survives a test
runner re-importing the module graph. In a deployed Worker it is undefined, and
reading it costs one property lookup on a path that only runs when the isolate
is about to end.

### The lint rules

```js
// eslint.config.mjs
import deferredLoading from "@curlewlabs-com/worker-lazy/eslint";

export default [
  {
    files: ["src/**/*.ts"],
    plugins: { "deferred-loading": deferredLoading },
    rules: {
      "deferred-loading/no-static-value-import": "error",
      "deferred-loading/dynamic-import-in-lazy-only": "error",
    },
  },
  {
    // Only the modules holding the entry handlers and Durable Object classes.
    files: ["src/index.ts"],
    rules: { "deferred-loading/non-async-dispatch-shell": "error" },
  },
];
```

TypeScript sources need a parser that reports `import type`, such as
`typescript-eslint`'s.

- **`no-static-value-import`** - every static import or re-export of a value
  is an error, TypeScript's `import x = require("./x")` included, except of
  `@curlewlabs-com/worker-lazy` itself. `import type`
  and `export type` are erased at build and always allowed. An import or
  re-export whose specifiers are each marked `type` (`import { type A } from
"./x"`) is not: under `verbatimModuleSyntax` it is kept as
  `import {} from "./x"` and still loads `./x`, so the rule asks for the
  declaration-level form. A static edge the
  runtime genuinely needs before any handler runs - a Durable Object class it
  must find among the entry's exports, a superclass - is allowed by a
  directive on the line above it or at the end of its line, naming its exact
  source and a reason:

  ```ts
  // deferred-loading static-edge ./counter -- the runtime finds this class by its export name.
  export { Counter } from "./counter";
  ```

  A directive that names another source, has no reason after `--`, or is not
  attached to an import or export is itself an error.

- **`dynamic-import-in-lazy-only`** - `import()` is allowed only as the body of
  a loader passed to `@curlewlabs-com/worker-lazy`'s `lazy()` (aliases
  included; a local function named `lazy` does not count), and only with a
  literal relative specifier (`./` or `../`). A computed specifier makes the
  bundler guess a set of files or leaves the import unresolved. A package specifier makes the
  package's entry a chunk entry point whose whole export surface is kept, so
  give the package one local module that re-exports what you use, and load
  that.

- **`non-async-dispatch-shell`** - `fetch` and `scheduled` written as methods
  or function properties of the default-export object, and every method of a
  class that extends `DurableObject`, must not be `async` and must not contain
  `await`, so the loaded path runs without a microtask. The default export may
  be the object literal itself, the literal under `satisfies` or `as`, or a
  variable initialized with one (`export default handler`,
  `export { handler as default }`). Put the awaited work in the module the
  shell loads, and scope this rule to the shell files.

- **`no-module-scope-promise-adoption`** - a module-scope variable or an
  import whose type holds a promise (a `Promise` or any value with a callable
  `then`, possibly optional or behind a type alias, or an object with such a
  property) may be assigned, truthiness-tested (`if (x)`, `!x`), compared with
  `null` or `undefined`, and `typeof`-ed. Every other read is an error: returning it, awaiting it,
  calling `.then` on it, copying it to a local, passing it on, reading through
  it with `?.`, or `x ??= ...`. Each of those can hand one request's promise to
  another.

  ```ts
  let refreshing: Promise<string> | null = null;

  export async function token(): Promise<string> {
    if (refreshing) return refreshing; // error: another request's promise
    // ...
  }
  ```

  Cache the resolved value instead, or keep the promise in a
  `WeakMap<object, Promise<T>>` keyed on an object that belongs to one
  request, which only callers within that request can reach. A module-scope
  promise used only as a marker ("a refresh is already running"), tested but
  never awaited by anyone but its creator, passes. A creator that needs to
  return its own promise keeps a local reference to it.

  The rule asks the TypeScript checker for each variable's type, so it needs
  type information, and it throws rather than passing everything when the
  parser was given none:

  ```js
  // eslint.config.mjs
  import tseslint from "typescript-eslint";
  import workerLazy from "@curlewlabs-com/worker-lazy/eslint";

  export default [
    {
      files: ["src/**/*.ts"],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          projectService: true,
          tsconfigRootDir: import.meta.dirname,
        },
      },
      plugins: { "worker-lazy": workerLazy },
      rules: { "worker-lazy/no-module-scope-promise-adoption": "error" },
    },
  ];
  ```

  No rule is on unless your config names it, so this rule changes nothing for
  a config that lists only the other three.

## Limits

- The rules recognize the primitive only by the exact specifier
  `@curlewlabs-com/worker-lazy`. Re-exporting `lazy` from a module of your own
  hides it from `dynamic-import-in-lazy-only`.
- `non-async-dispatch-shell` knows the `fetch` and `scheduled` handlers and
  classes extending a class named `DurableObject`. Other handlers (`queue`,
  `email`, `tail`) are not checked, and neither is a default export the rule
  cannot trace to an object literal in the same file (a function's result, an
  imported object, a spread's members).
- `no-module-scope-promise-adoption` looks only at module-scope variables
  and imports, and leaves two shapes alone because their lifetime is not in
  the source. A promise-typed variable inside a factory function, such as a
  memoizer the factory returns, is the hazard when the factory is called at
  module scope and correct when it is called per request; where it is called
  is outside the file. And a keyed container such as
  `Map<string, Promise<T>>` at module scope is the hazard in container form,
  but its type is indistinguishable from the request-keyed `WeakMap` above:
  both expose only methods. Review those two by hand.
- The rules see source text, not the bundle. Whether a module is in the
  startup graph is the bundler's answer: an esbuild metafile's static
  `import-statement` edges from the entry output give the exact set, which is
  worth comparing against a list you have reviewed.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option. Releases published under the MIT license alone may also be used
under either license.

### Contribution

By submitting a contribution for inclusion in this project, you agree that it
is dual licensed as above, without any additional terms or conditions.
