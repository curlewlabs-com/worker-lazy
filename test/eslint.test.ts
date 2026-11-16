import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import plugin from "../eslint/index.mjs";

// Rule-fixture tests: each rule runs through ESLint's Linter over planted source,
// with the TypeScript parser so `import type` and inline type specifiers parse
// as they do in a Worker's sources.

const linter = new Linter();

function lint(code: string, filename = "src/fixture.ts"): Linter.LintMessage[] {
  return linter.verify(
    code,
    {
      files: ["**/*.ts"],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      },
      plugins: { "deferred-loading": plugin },
      rules: {
        "deferred-loading/no-static-value-import": "error",
        "deferred-loading/dynamic-import-in-lazy-only": "error",
        "deferred-loading/non-async-dispatch-shell": "error",
      },
    },
    filename,
  );
}

const STATIC = "deferred-loading/no-static-value-import";
const DYNAMIC = "deferred-loading/dynamic-import-in-lazy-only";
const SHELL = "deferred-loading/non-async-dispatch-shell";
const PRIMITIVE = 'import { lazy } from "@curlewlabs-com/worker-lazy";';

function only(messages: Linter.LintMessage[]): Linter.LintMessage {
  assert.equal(messages.length, 1, JSON.stringify(messages));
  const [message] = messages;
  assert.ok(message !== undefined);
  return message;
}

function ofRule(messages: Linter.LintMessage[], ruleId: string) {
  return messages.filter((m) => m.ruleId === ruleId);
}

describe("no-static-value-import", () => {
  it("fires on a static value import, as an error", () => {
    const m = only(lint('import { foo } from "./bar";'));
    assert.equal(m.ruleId, STATIC);
    assert.equal(m.severity, 2);
    assert.equal(m.messageId, "staticValueImport");
  });

  it("exempts imports erased at build", () => {
    assert.equal(lint('import type { Foo } from "./bar";').length, 0);
    assert.equal(lint('import { type A, type B } from "./bar";').length, 0);
  });

  // A side-effect import has no specifiers, so it is never erased and always
  // extends the static graph.
  it("fires on a side-effect import", () => {
    assert.equal(only(lint('import "./bar";')).ruleId, STATIC);
  });

  it("fires on value re-exports, which load their source at module-eval", () => {
    const named = only(lint('export { foo } from "./bar";'));
    assert.equal(named.ruleId, STATIC);
    assert.equal(named.messageId, "staticValueReexport");
    const star = only(lint('export * from "./bar";'));
    assert.equal(star.messageId, "staticValueReexport");
  });

  it("exempts type-only re-exports and local exports", () => {
    assert.equal(lint('export type { Foo } from "./bar";').length, 0);
    assert.equal(lint('export { type A, type B } from "./bar";').length, 0);
    assert.equal(lint("export const x = 1;").length, 0);
    assert.equal(lint("const y = 1; export { y };").length, 0);
  });

  it("exempts the primitive, which is the bootstrap and cannot defer itself", () => {
    assert.equal(lint('import { lazy, withLazy } from "@curlewlabs-com/worker-lazy";').length, 0);
    assert.equal(lint('export { lazy } from "@curlewlabs-com/worker-lazy";').length, 0);
  });

  // The exemption is the exact package specifier, so it cannot be widened by a
  // local module that happens to be called "lazy", by the package's lint entry,
  // by a package whose name merely starts the same way, or by the same name
  // outside the scope, which is anyone's to publish.
  it("does not exempt anything that only resembles the primitive", () => {
    for (const source of [
      "./lazy",
      "../lazy.js",
      "@curlewlabs-com/worker-lazy/eslint",
      "@curlewlabs-com/worker-lazy-extra",
      "worker-lazy",
    ]) {
      const m = only(lint(`import { lazy } from "${source}";`));
      assert.equal(m.ruleId, STATIC, source);
    }
  });

  // A directive exempts ONLY the adjacent edge whose source it names exactly; a
  // different import in the same file, or a near-sibling source, still fires.
  it("honours an adjacent static-edge directive for its exact source only", () => {
    assert.equal(
      lint(
        '// deferred-loading static-edge ./my-object -- the runtime binds this exported class name.\nexport { MyObject } from "./my-object";',
      ).length,
      0,
    );
    assert.equal(
      lint(
        'import { DurableObject } from "cloudflare:workers"; // deferred-loading static-edge cloudflare:workers -- the superclass must exist before any request.',
      ).length,
      0,
    );
    const sibling = only(
      lint(
        '// deferred-loading static-edge ./my-object -- the runtime binds this exported class name.\nimport { MyObjectImpl } from "./my-object-impl";',
      ),
    );
    assert.equal(sibling.messageId, "badStaticEdgeDirective");
  });

  // A stale or reasonless directive would otherwise sit in the source as an
  // ambient comment that looks like an exemption.
  it("reports directives that are detached or malformed", () => {
    const detached = lint(
      '// deferred-loading static-edge ./bar -- reason\n\nimport { foo } from "./bar";',
    );
    assert.equal(detached.length, 2);
    assert.ok(detached.some((x) => x.messageId === "unusedStaticEdgeDirective"));
    assert.ok(detached.some((x) => x.messageId === "staticValueImport"));

    const malformed = only(
      lint('// deferred-loading static-edge ./bar\nimport { foo } from "./bar";'),
    );
    assert.equal(malformed.messageId, "malformedStaticEdgeDirective");
  });
});

describe("dynamic-import-in-lazy-only", () => {
  it("fires on a bare await import()", () => {
    const m = only(
      lint('async function f() { const mod = await import("./bar"); return mod; }'),
    );
    assert.equal(m.ruleId, DYNAMIC);
    assert.equal(m.severity, 2);
    assert.equal(m.messageId, "bareDynamicImport");
  });

  it("allows import() as the loader body of the primitive lazy()", () => {
    assert.equal(lint(`${PRIMITIVE} const load = lazy(() => import("./bar.js"));`).length, 0);
    assert.equal(lint(`${PRIMITIVE} const load = lazy(() => import(\`./bar.js\`));`).length, 0);
    assert.equal(lint(`${PRIMITIVE} const load = lazy(() => import("../../shared/bar.js"));`).length, 0);
    assert.equal(
      lint('import { lazy as defer } from "@curlewlabs-com/worker-lazy"; const load = defer(() => import("./bar.js"));')
        .length,
      0,
    );
  });

  // Computed specifiers either stay unresolved or make the bundler enumerate an
  // implicit, overbroad glob, so keyed loading uses explicit static thunks.
  it("fires on a computed loader specifier", () => {
    for (const loader of [
      "import(specifier)",
      'import("./locales/" + locale + ".js")',
      "import(`./locales/${locale}.js`)",
    ]) {
      const m = only(lint(`${PRIMITIVE} const load = lazy(() => ${loader});`));
      assert.equal(m.ruleId, DYNAMIC, loader);
      assert.equal(m.messageId, "nonStaticDynamicImport", loader);
    }
  });

  // import() resolves to a namespace object, so a package entry becomes a chunk
  // entry point whose whole export surface is preserved.
  it("fires on a package specifier, naming it", () => {
    for (const specifier of ["some-package", "@scope/pkg", "@scope/pkg/sub", "node:crypto"]) {
      const m = only(lint(`${PRIMITIVE} const load = lazy(() => import("${specifier}"));`));
      assert.equal(m.messageId, "packageDynamicImport", specifier);
      assert.ok(m.message.includes(specifier));
    }
    const templated = only(lint(`${PRIMITIVE} const load = lazy(() => import(\`@scope/pkg\`));`));
    assert.equal(templated.messageId, "packageDynamicImport");
  });

  // The loader shape alone is not enough: the callee must resolve to the
  // primitive's own binding.
  it("fires when lazy is not the primitive", () => {
    const other = lint('import { lazy } from "./other"; const load = lazy(() => import("./bar.js"));');
    assert.equal(ofRule(other, DYNAMIC).length, 1);
    const shadowed = only(
      lint('function lazy(fn) { return fn(); } const load = lazy(() => import("./bar.js"));'),
    );
    assert.equal(shadowed.ruleId, DYNAMIC);
  });
});

describe("non-async-dispatch-shell", () => {
  it("fires on async fetch and scheduled entries", () => {
    for (const code of [
      'export default { async fetch(req, env, ctx) { return new Response("x"); } };',
      "export default { async scheduled(event, env, ctx) { return; } };",
    ]) {
      const m = ofRule(lint(code), SHELL);
      assert.equal(m.length, 1, code);
      assert.equal(m[0]?.messageId, "asyncDispatchShell");
    }
  });

  it("allows a plain shell that returns withLazy(...)", () => {
    const code =
      "export default { fetch(req, env, ctx) { return withLazy(impl, (mod) => mod.handleFetch(req, env, ctx)); } };";
    assert.equal(ofRule(lint(code), SHELL).length, 0);
  });

  // The withLazy callback runs synchronously on the warm path, so an await
  // inside it is a warm-path microtask even though the shell itself is not async.
  it("fires on an await anywhere inside a shell", () => {
    const code =
      "export default { fetch(req, env, ctx) { return withLazy(impl, async (mod) => await mod.handleFetch(req)); } };";
    assert.ok(ofRule(lint(code), SHELL).some((x) => x.messageId === "awaitInDispatchShell"));
  });

  it("treats Durable Object methods as shells", () => {
    const asyncMethod = ofRule(
      lint("class G extends DurableObject { async tick(now) { return this.run(now); } }"),
      SHELL,
    );
    assert.equal(asyncMethod[0]?.messageId, "asyncDispatchShell");
    assert.equal(
      ofRule(
        lint(
          "class G extends DurableObject { tick(now) { return withLazy(impl, (mod) => new mod.Impl(this.ctx, this.env).tick(now)); } }",
        ),
        SHELL,
      ).length,
      0,
    );
  });

  it("leaves async functions and non-Durable-Object classes alone", () => {
    assert.equal(ofRule(lint("async function handleFetch(req) { return await doWork(req); }"), SHELL).length, 0);
    assert.equal(ofRule(lint("class Foo { async bar() { return await x(); } }"), SHELL).length, 0);
  });
});
