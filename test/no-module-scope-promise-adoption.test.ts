import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ESLint, Linter } from "eslint";
import tseslint from "typescript-eslint";
import plugin from "../eslint/index.mjs";

// Rule-fixture tests for no-module-scope-promise-adoption. Each case lints one
// planted fixture and asserts the rule fires or stays silent.
//
// Unlike eslint.test.ts, these do not go through Linter.verify over a string:
// the rule is type-aware, and typescript-eslint resolves types only for files a
// tsconfig project can reach, so the fixtures are real files under a real
// project in a scratch directory. Only Promise/thenable resolution comes off
// that project, which is why it names no lib beyond the default.

const RULE = "worker-lazy/no-module-scope-promise-adoption";

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "promise-adoption-"));
after(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

writeFileSync(
  join(FIXTURE_DIR, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      noEmit: true,
      types: [],
    },
    include: ["*.ts"],
  }),
);

const eslint = new ESLint({
  cwd: FIXTURE_DIR,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.ts"],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          project: ["./tsconfig.json"],
          tsconfigRootDir: FIXTURE_DIR,
        },
      },
      plugins: { "worker-lazy": plugin },
      rules: { [RULE]: "error" },
    },
  ],
});

// The modules the import cases import from. No case lints them, and they are
// written before any case for the reason lintCase gives. shared.ts exports
// promise holders beside a function, a plain value and types; pending.ts's
// and thenable.ts's module objects are themselves thenable; helpers.ts exports
// no promise at all.
writeFileSync(
  join(FIXTURE_DIR, "shared.ts"),
  `
export type Shared = { pending?: Promise<number> };
export type Result = number;
export const shared: Shared = {};
export const ready: Promise<number> = Promise.resolve(1);
export const label = "shared";
export function start(): void {}
export class Cache {
  static pending?: Promise<number>;
  size = 0;
}
export default ready;
`,
);
writeFileSync(
  join(FIXTURE_DIR, "pending.ts"),
  `
declare const pending: Promise<number>;
export = pending;
`,
);
writeFileSync(
  join(FIXTURE_DIR, "thenable.ts"),
  `
export function then(resolve: (v: number) => void): void {
  resolve(1);
}
`,
);
writeFileSync(
  join(FIXTURE_DIR, "helpers.ts"),
  `
export function twice(n: number): number {
  return n * 2;
}
`,
);

let fixtureN = 0;

// Registers one case. The fixture is written HERE, while the module is being
// evaluated and the tests are only being registered, not inside the test body,
// and the result depends on that ordering. typescript-eslint infers a "single
// run" from `process.env.CI`, and in that mode it builds ONE immutable program
// from the files present at the first lint instead of a watch program that
// picks up later arrivals. A fixture written inside a test body would not
// exist when that program is built, and every case after the first would fail
// with "file was not found in any of the provided project(s)" - in CI only.
// Writing at registration time puts all of them on disk before any lint, so the
// suite does not depend on which program mode the parser chose.
//
// A fresh filename per case for the same reason one program serves them all:
// rewriting a single path would serve the first case's AST to every case after
// it, a silent all-green.
function lintCase(
  name: string,
  code: string,
  check: (messages: Linter.LintMessage[]) => void,
): void {
  fixtureN += 1;
  const file = join(FIXTURE_DIR, `fixture${String(fixtureN)}.ts`);
  writeFileSync(file, code);
  it(name, async () => {
    const results = await eslint.lintFiles([file]);
    const messages = results.flatMap((r) => r.messages);
    for (const m of messages) {
      assert.equal(m.fatal, undefined, `fixture failed to parse: ${m.message}`);
    }
    check(messages);
  });
}

describe("no-module-scope-promise-adoption: a module-scope promise read as a value", () => {
  // The literal singleflight. The READ is the defect: the adopting request
  // holds no pending work of its own.
  lintCase(
    "returning the module-scope slot fires",
    `
let inflight: Promise<number> | null = null;
export async function get(): Promise<number> {
  if (inflight) return inflight;
  const own = Promise.resolve(1);
  inflight = own;
  return own;
}
`,
    (m) => {
      assert.equal(m.length, 1);
      assert.equal(m[0]?.ruleId, RULE);
      // 2 is error: a warning would let the shape ship.
      assert.equal(m[0].severity, 2);
      assert.match(m[0].message, /inflight/);
    },
  );

  lintCase(
    "awaiting the module-scope slot fires",
    `
let inflight: Promise<number> | null = null;
export async function get(): Promise<number> {
  if (inflight) return await inflight;
  return 0;
}
`,
    (m) => {
      assert.equal(m.length, 1);
    },
  );

  // Copy to a local, then return the local: what a check keyed on
  // return/await positions alone misses.
  lintCase(
    "aliasing the slot to a local fires",
    `
let inflight: Promise<number> | null = null;
export function get(): Promise<number> | null {
  const shared = inflight;
  return shared;
}
`,
    (m) => {
      assert.equal(m.length, 1);
    },
  );

  // `??=` reads as well as writes, so what it hands back is somebody else's
  // in-flight promise.
  lintCase(
    "a read-modify-write on the slot fires",
    `
let pending: Promise<number> | undefined;
export function load(): Promise<number> {
  return (pending ??= Promise.resolve(1));
}
`,
    (m) => {
      assert.equal(m.length, 1);
    },
  );

  // The promise sits on a property of a record rather than being the
  // binding's own type.
  lintCase(
    "a promise held on a property fires",
    `
let inflight: { key: string; promise: Promise<number> } | null = null;
export function get(key: string): Promise<number> | null {
  if (inflight?.key === key) return inflight.promise;
  return null;
}
`,
    (m) => {
      assert.ok(m.length >= 1);
      assert.ok(m.every((x) => x.ruleId === RULE));
    },
  );

  // What type-awareness buys over matching the annotation: the slot is
  // declared through an alias, and nothing in the declaration names "Promise".
  lintCase(
    "a promise behind a type alias fires",
    `
type Refresh = Promise<number>;
let inflight: Refresh | null = null;
export function get(): Refresh | null {
  return inflight;
}
`,
    (m) => {
      assert.equal(m.length, 1);
    },
  );

  // An optional or nullable promise property has the type
  // `Promise<T> | undefined`, which the checker gives no common `then`, so
  // each union member has to be asked. Missing it would pass the singleflight
  // in its commonest record form.
  lintCase(
    "an optional promise property fires",
    `
const state: { pending?: Promise<number> } = {};
export function load(): Promise<number> {
  return (state.pending ??= Promise.resolve(1));
}
`,
    (m) => {
      assert.equal(m.length, 1);
    },
  );

  lintCase(
    "a promise-or-value property fires",
    `
let slot: { value: Promise<number> | number } = { value: 0 };
export function get(): Promise<number> | number {
  return slot.value;
}
`,
    (m) => {
      assert.equal(m.length, 1);
    },
  );

  // Thenable is structural: await adopts anything with a callable then.
  lintCase(
    "a custom thenable fires",
    `
const ready: { then(resolve: (v: number) => void): void } = {
  then(resolve) {
    resolve(1);
  },
};
export function get(): typeof ready {
  return ready;
}
`,
    (m) => {
      assert.equal(m.length, 1);
    },
  );

  // `var` is hoisted to module scope from inside a top-level block, so the
  // slot lives as long as the module whatever statement declares it.
  lintCase(
    "a var declared in a top-level block fires",
    `
if (Math.random() > 2) {
  var pending: Promise<number> | undefined;
}
export function load(): Promise<number> {
  return (pending ??= Promise.resolve(1));
}
`,
    (m) => {
      assert.equal(m.length, 1);
    },
  );

  // The exporting module's slot is shared by every importer, and the read
  // that adopts it is in the importing file, so imports are checked there.
  lintCase(
    "reading an imported promise slot fires",
    `
import { shared } from "./shared";
export function load(): Promise<number> {
  return (shared.pending ??= Promise.resolve(1));
}
`,
    (m) => {
      assert.equal(m.length, 1);
      assert.match(m[0]?.message ?? "", /'shared'/);
    },
  );

  lintCase(
    "returning an imported default promise fires",
    `
import ready from "./shared";
export function get(): Promise<number> {
  return ready;
}
`,
    (m) => {
      assert.equal(m.length, 1);
    },
  );

  // Through a namespace import, the export read is the slot: both reads name
  // it, and nothing else on the namespace is reported.
  lintCase(
    "reading a promise export through a namespace fires",
    `
import * as ns from "./shared";
export function get(): Promise<number> {
  ns.start();
  ns.shared.pending ??= Promise.resolve(2);
  return ns.ready;
}
`,
    (m) => {
      assert.deepEqual(
        m.map((x) => [x.line, x.message.match(/Module-scope '([^']+)'/)?.[1]]),
        [
          [5, "ns.shared"],
          [6, "ns.ready"],
        ],
      );
    },
  );

  // TypeScript's import-equals form binds the module object too, so it is
  // judged by export in the same way, an alias of one export included.
  lintCase(
    "an import-equals module binding is judged by export",
    `
import m = require("./shared");
import Cached = m.Cache;
export function get(): Promise<number> {
  m.start();
  return m.ready;
}
export const c: Cached = new Cached();
`,
    (m) => {
      assert.deepEqual(
        m.map((x) => [x.line, x.message.match(/Module-scope '([^']+)'/)?.[1]]),
        [
          [3, "m.Cache"],
          [6, "m.ready"],
          [8, "Cached"],
        ],
      );
    },
  );

  // A key the source spells out names its export as a dot access does.
  lintCase(
    "a literal computed key on a namespace is judged by its export",
    `
import * as ns from "./shared";
export function get(): Promise<number> | null {
  ns["start"]();
  if (ns["ready"]) return ns["ready"];
  return null;
}
`,
    (m) => {
      assert.deepEqual(
        m.map((x) => [x.line, x.message.match(/Module-scope '([^']+)'/)?.[1]]),
        [[5, "ns.ready"]],
      );
    },
  );

  // When the module object is itself thenable, there is no export to judge
  // apart from it: reading the binding at all reads the promise.
  lintCase(
    "a module object that is itself thenable fires",
    `
import pending = require("./pending");
import * as thenable from "./thenable";
export async function get(): Promise<number> {
  await thenable;
  return pending;
}
`,
    (m) => {
      assert.deepEqual(
        m.map((x) => x.line),
        [5, 6],
      );
    },
  );

  // Handing the namespace on hands on every export, the promise among them.
  lintCase(
    "passing on a namespace that exports a promise fires",
    `
import * as ns from "./shared";
export function all(): object {
  return ns;
}
`,
    (m) => {
      assert.equal(m.length, 1);
    },
  );

  // One binding, read in both positions: the annotation reads nothing, and
  // only the value read is reported, on its own line.
  lintCase(
    "a value import used in both positions fires only for the value read",
    `
import { Cache } from "./shared";
export const local: Cache = { size: 0 };
export function load(): Promise<number> {
  return (Cache.pending ??= Promise.resolve(1));
}
`,
    (m) => {
      assert.deepEqual(
        m.map((x) => x.line),
        [5],
      );
    },
  );

  // A module-scope `const` promise is the hazard with no window at all: every
  // request after the first adopts it.
  lintCase(
    "a module-scope const promise fires",
    `
const bootstrap: Promise<number> = Promise.resolve(1);
export async function get(): Promise<number> {
  return bootstrap;
}
`,
    (m) => {
      assert.equal(m.length, 1);
    },
  );
});

describe("no-module-scope-promise-adoption: the shapes that are safe", () => {
  // A refresh marker: published by its creator, read by everyone else only as
  // "a refresh is already running", and never awaited. A rule keyed on the
  // DECLARATION would need an exemption for this, which is why the ban is on
  // reading the slot instead.
  lintCase(
    "assignment, truthiness tests, and nullish comparisons pass",
    `
let inflight: Promise<number> | null = null;
export function get(cached: number | null): Promise<number> | number | null {
  if (inflight) return cached;
  if (inflight !== null) return cached;
  if (inflight === undefined) return cached;
  if (!inflight) {
    const own = Promise.resolve(1).finally(() => {
      inflight = null;
    });
    inflight = own;
    return own;
  }
  return null;
}
`,
    (m) => {
      assert.equal(m.length, 0);
    },
  );

  // Sharing confined to callers that already share one I/O context, because
  // the key IS the request's context object.
  lintCase(
    "a WeakMap gate keyed on the context passes",
    `
const gate = new WeakMap<object, Promise<number>>();
export function once(ctx: object): Promise<number> {
  const existing = gate.get(ctx);
  if (existing !== undefined) return existing;
  const own = Promise.resolve(1);
  gate.set(ctx, own);
  return own;
}
`,
    (m) => {
      assert.equal(m.length, 0);
    },
  );

  // The correct pattern throughout: cache the RESOLVED value, never the
  // promise.
  lintCase(
    "a resolved-value cache passes",
    `
let tokenCache: { token: string; expiresAt: number } | null = null;
export async function get(): Promise<string> {
  if (tokenCache) return tokenCache.token;
  tokenCache = { token: await Promise.resolve("t"), expiresAt: 0 };
  return tokenCache.token;
}
`,
    (m) => {
      assert.equal(m.length, 0);
    },
  );
});

describe("no-module-scope-promise-adoption: what is not a promise or not a read", () => {
  // A field named `then` that cannot be called makes nothing thenable; a
  // resolved record that happens to carry one is a plain value.
  lintCase(
    "a record with a non-callable then field passes",
    `
const cached = { then: "later", token: "t" };
export function get(): string {
  return cached.token;
}
`,
    (m) => {
      assert.equal(m.length, 0);
    },
  );

  // The false report this guards against: type positions read nothing at run
  // time, and naming a type through a namespace that also exports a promise
  // was once reported as a read of that namespace.
  lintCase(
    "type-only imports and namespace-imported types pass",
    `
import type * as SharedTypes from "./shared";
import type { Shared } from "./shared";
import { type Shared as Alias, Cache } from "./shared";
import * as ns from "./shared";
export type Out = SharedTypes.Result | ns.Result | Shared | Alias;
export const n: ns.Result = 1;
export const slot: SharedTypes.Shared = {};
export type Field = typeof ns.ready;
export function size(c: Cache): ns.Result {
  return c.size;
}
`,
    (m) => {
      assert.equal(m.length, 0);
    },
  );

  // An export that holds no promise is not a slot, read through a namespace or
  // by name; a namespace with no promise among its exports may be handed on;
  // and a namespace's promise export may be tested like any other slot.
  lintCase(
    "imported functions, values and promise-free namespaces pass",
    `
import { start, label } from "./shared";
import * as ns from "./shared";
import * as helpers from "./helpers";
export function run(): string {
  start();
  ns.start();
  if (ns.ready) helpers.twice(1);
  const all: object = helpers;
  return label + ns.label + String(all);
}
`,
    (m) => {
      assert.equal(m.length, 0);
    },
  );

  // `typeof x` in a type position is erased at build, so it reads nothing at
  // run time, plain or qualified.
  lintCase(
    "typeof in a type position passes",
    `
let pending: Promise<number> | null = null;
const state: { pending?: Promise<number> } = {};
export type Result = Awaited<typeof pending>;
export type Field = typeof state.pending;
export function start(): void {
  pending = Promise.resolve(1);
}
`,
    (m) => {
      assert.equal(m.length, 0);
    },
  );
});

describe("no-module-scope-promise-adoption: the documented gaps, pinned as passing", () => {
  // A closure-scope memoizer is the hazard when the factory runs at module
  // scope and correct when it runs per request; where the factory is called
  // is not something the AST answers.
  lintCase(
    "a function-scope memoizer is out of scope",
    `
export function memo(): () => Promise<number> {
  let pending: Promise<number> | undefined;
  return () => (pending ??= Promise.resolve(1));
}
`,
    (m) => {
      assert.equal(m.length, 0);
    },
  );

  // A string-keyed container is the hazard in container form, on the same side
  // of the type test as the WeakMap gate, because a container's properties are
  // its methods.
  lintCase(
    "a string-keyed container is out of scope",
    `
const gate = new Map<string, Promise<number>>();
export function get(key: string): Promise<number> | undefined {
  return gate.get(key);
}
`,
    (m) => {
      assert.equal(m.length, 0);
    },
  );
});

describe("no-module-scope-promise-adoption: configuration", () => {
  // Without type information the rule could see no type and would pass every
  // file; it has to refuse to run instead, so a config that forgets the
  // project fails loudly.
  it("refuses to run without type information", () => {
    const linter = new Linter();
    assert.throws(
      () =>
        linter.verify(
          "let inflight: Promise<number> | null = null;\nexport const get = () => inflight;\n",
          {
            files: ["**/*.ts"],
            languageOptions: { parser: tseslint.parser },
            plugins: { "worker-lazy": plugin },
            rules: { [RULE]: "error" },
          },
          "src/fixture.ts",
        ),
      /requires type information/,
    );
  });
});
