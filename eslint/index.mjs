// @ts-check
// ESLint rules for a Worker's module loading and for the promises its requests
// share. The first three keep module loading deferred. `lazy()` /
// `withLazy()` from @curlewlabs-com/worker-lazy is the deferral primitive and
// the default way to reach a module; a static edge is the source-local
// exception, and carries an adjacent directive naming the exact import/export
// source and the reason the edge cannot defer. Either way an isolate evaluates and allocates only its
// working set.
//
// no-static-value-import: a static import/re-export edge must defer through
// lazy() or carry an adjacent `deferred-loading static-edge` directive naming
// that exact source. dynamic-import-in-lazy-only: a dynamic import() is
// sanctioned only as a lazy() loader body, and only over a relative specifier -
// dynamic-importing a package makes its entry an un-shakeable chunk entry point.
// non-async-dispatch-shell: the entry shells must stay non-async and await-free
// so the warm lazy() path adds no microtask; scope it with ESLint's `files` to
// the entry and Durable Object shell files only, so the modules they load, which
// legitimately await inside already-async I/O handlers, never trip it.
//
// no-module-scope-promise-adoption: a module-scope binding whose type holds a
// promise may be assigned and tested, never read as a value, because a request
// that awaits a promise another request created is canceled as hung. It is the
// one rule here that needs type information.
//
// This file is the package's lint entry only. The runtime entry never imports
// it, so a Worker that bundles lazy() bundles none of this.

const STATIC_EDGE_DIRECTIVE_MARKER = "deferred-loading static-edge";
const STATIC_EDGE_DIRECTIVE =
  /(?:^|\s)deferred-loading\s+static-edge\s+(\S+)\s+--\s+\S/;

/** @param {string} text */
function parseStaticEdgeDirective(text) {
  const match = STATIC_EDGE_DIRECTIVE.exec(text);
  if (!match) return null;
  return { source: match[1] };
}

/** @param {string} text */
function hasStaticEdgeDirectiveMarker(text) {
  return text.includes(STATIC_EDGE_DIRECTIVE_MARKER);
}

// The deferral primitive is this package's runtime entry - the one module that
// must stay a static edge (it is the bootstrap every shell reaches for and cannot
// lazy-load itself). Matched by the exact specifier: a subpath of the package, a
// local module named "lazy", or a same-prefixed package is not the primitive.
const PRIMITIVE_SPECIFIER = "@curlewlabs-com/worker-lazy";

/** @param {string} source the import/export specifier */
function isPrimitiveImport(source) {
  return source === PRIMITIVE_SPECIFIER;
}

// True when a call callee resolves to a binding that is `import { lazy } from <the
// primitive>` - the sanctioned lazy(), not a local shadow (`function lazy(){}`) or
// a `lazy` imported from some other module. An alias (`import { lazy as l }`) still
// matches: it is resolved by its *imported* name against the primitive source.
/**
 * @param {import('eslint').Rule.RuleContext} context
 * @param {any} ident the CallExpression callee (an Identifier)
 */
function isPrimitiveLazyBinding(context, ident) {
  let variable = null;
  for (
    let scope = /** @type {import('eslint').Scope.Scope | null} */ (
      context.sourceCode.getScope(ident)
    );
    scope && !variable;
    scope = scope.upper
  ) {
    variable = scope.set.get(ident.name) ?? null;
  }
  if (!variable) return false;
  return variable.defs.some(
    (/** @type {any} */ def) =>
      def.type === "ImportBinding" &&
      def.node?.type === "ImportSpecifier" &&
      def.node.imported?.name === "lazy" &&
      def.parent?.type === "ImportDeclaration" &&
      isPrimitiveImport(String(def.parent.source.value)),
  );
}

// `import { type A } from "./x"`: every specifier is type-only but the
// declaration is not. The compiler erases it only when it drops unused imports;
// under `verbatimModuleSyntax` it keeps `import {} from "./x"`, which loads
// "./x". The declaration-level form is erased in every mode, so that is the one
// exempted, and this shape gets a message naming it.
/**
 * @param {any[]} specifiers
 * @param {"importKind" | "exportKind"} kindKey
 */
function allSpecifiersTypeOnly(specifiers, kindKey) {
  return (
    specifiers.length > 0 && specifiers.every((s) => s[kindKey] === "type")
  );
}

/** @type {import('eslint').Rule.RuleModule} */
const noStaticValueImport = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow static value imports and re-exports; defer through lazy() from @curlewlabs-com/worker-lazy, or mark an edge that cannot defer with an adjacent source-local directive. import type is exempt.",
    },
    schema: [
      {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    ],
    messages: {
      staticValueImport:
        "Static value import of '{{source}}' extends the startup closure and couples this module to the imported module's loading fate. Defer through lazy() from @curlewlabs-com/worker-lazy - size is not a reason to keep it static; an edge reached only through function bodies defers however small. Only an edge the runtime needs before any handler runs (a class it must find among the entry's static exports, a superclass) earns a source-local `deferred-loading static-edge <source> -- <why>` directive; logging is not such an edge. A dedicated leaf beats folding it into an already-imported module, which couples every caller to the merged working set. `import type` is exempt.",
      inlineTypeOnlyImport:
        "Every specifier of this import of '{{source}}' is marked `type`, but the declaration is not, so it is erased only when the compiler drops unused imports: under `verbatimModuleSyntax` it is kept as `import {} from '{{source}}'`, which still loads the module at startup. Write `import type { ... } from '{{source}}'`, which is erased in every mode.",
      inlineTypeOnlyReexport:
        "Every specifier of this re-export of '{{source}}' is marked `type`, but the declaration is not, so under `verbatimModuleSyntax` it is kept as `export {} from '{{source}}'`, which still loads the module at startup. Write `export type { ... } from '{{source}}'`, which is erased in every mode.",
      staticValueReexport:
        "Static value re-export of '{{source}}' extends the startup closure and couples this module to the re-exported module's loading fate. Reach it through lazy() at a use site instead, or drop the re-export. `export type ... from` is exempt. See the @curlewlabs-com/worker-lazy README.",
      badStaticEdgeDirective:
        "Static-edge directive names '{{directiveSource}}' but this edge imports/re-exports '{{source}}'. The directive must be adjacent to the import/export and match its source exactly.",
      malformedStaticEdgeDirective:
        "Static-edge directive must be `deferred-loading static-edge <source> -- <why>` and be adjacent to the import/export it exempts.",
      unusedStaticEdgeDirective:
        "Static-edge directive is not attached to a static import/export edge. Remove it, or move it directly above or onto the import/export it exempts.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const usedDirectiveComments = new Set();

    /** @param {any} comment */
    function reportMalformedDirective(comment) {
      usedDirectiveComments.add(comment);
      context.report({
        node: comment,
        messageId: "malformedStaticEdgeDirective",
      });
      return true;
    }

    /**
     * @param {any} node
     * @param {string} source
     */
    function hasSourceLocalDirective(node, source) {
      const candidateComments = [];
      const before = sourceCode.getCommentsBefore(node);
      const lastBefore = before.at(-1);
      if (lastBefore?.loc?.end.line === node.loc.start.line - 1) {
        candidateComments.push(lastBefore);
      }
      for (const comment of sourceCode.getCommentsAfter(node)) {
        if (comment.loc?.start.line === node.loc.end.line) {
          candidateComments.push(comment);
        }
      }
      for (const comment of candidateComments) {
        if (!hasStaticEdgeDirectiveMarker(comment.value)) continue;
        const directive = parseStaticEdgeDirective(comment.value);
        if (directive === null) return reportMalformedDirective(comment);
        usedDirectiveComments.add(comment);
        if (directive.source !== source) {
          context.report({
            node: comment,
            messageId: "badStaticEdgeDirective",
            data: { directiveSource: directive.source, source },
          });
        }
        return true;
      }
      return false;
    }

    // Report a static module-graph edge to `source` (an import or re-export)
    // unless it is the deferral primitive or it carries a source-local directive
    // matching the exact specifier.
    /**
     * @param {any} node
     * @param {string} source
     * @param {"staticValueImport" | "staticValueReexport" | "inlineTypeOnlyImport" | "inlineTypeOnlyReexport"} plainMessageId
     */
    function reportEdge(node, source, plainMessageId) {
      if (isPrimitiveImport(source)) return;
      if (hasSourceLocalDirective(node, source)) return;
      context.report({ node, messageId: plainMessageId, data: { source } });
    }
    return {
      /** @param {import('estree').ImportDeclaration & { importKind?: string }} node */
      ImportDeclaration(node) {
        // `import type ...` is erased at build in every compiler mode, so it is
        // always allowed. A side-effect import (no specifiers) is not erased,
        // so it still fires.
        if (node.importKind === "type") return;
        reportEdge(
          node,
          String(node.source.value),
          allSpecifiersTypeOnly(node.specifiers, "importKind")
            ? "inlineTypeOnlyImport"
            : "staticValueImport",
        );
      },
      // `import x = require("./m")` loads "./m" at module-eval like an import.
      // `import x = Ns.member` names a namespace member and is no module edge.
      /** @param {any} node */
      TSImportEqualsDeclaration(node) {
        if (node.importKind === "type") return;
        const reference = node.moduleReference;
        if (reference?.type !== "TSExternalModuleReference") return;
        reportEdge(
          node,
          String(reference.expression.value),
          "staticValueImport",
        );
      },
      // Re-exports are static edges too: `export { x } from "./m"` and
      // `export * from "./m"` eagerly load "./m" at module-eval, exactly like an
      // import. `export type ... from` is erased;
      // `export { x }` with no source is a local export (no edge).
      /** @param {import('estree').ExportNamedDeclaration & { exportKind?: string }} node */
      ExportNamedDeclaration(node) {
        if (!node.source) return;
        if (node.exportKind === "type") return;
        reportEdge(
          node,
          String(node.source.value),
          allSpecifiersTypeOnly(node.specifiers, "exportKind")
            ? "inlineTypeOnlyReexport"
            : "staticValueReexport",
        );
      },
      /** @param {import('estree').ExportAllDeclaration & { exportKind?: string }} node */
      ExportAllDeclaration(node) {
        if (node.exportKind === "type") return;
        reportEdge(node, String(node.source.value), "staticValueReexport");
      },
      "Program:exit"() {
        for (const comment of sourceCode.getAllComments()) {
          if (
            hasStaticEdgeDirectiveMarker(comment.value) &&
            !usedDirectiveComments.has(comment)
          ) {
            context.report({
              node: comment,
              messageId: "unusedStaticEdgeDirective",
            });
          }
        }
      },
    };
  },
};

/** @type {import('eslint').Rule.RuleModule} */
const dynamicImportInLazyOnly = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Allow static relative-specifier dynamic import() only as the loader body of lazy(() => import(...)).",
    },
    schema: [],
    messages: {
      bareDynamicImport:
        "A dynamic import() must be the loader body of lazy(() => import(...)) from @curlewlabs-com/worker-lazy. A bare `await import()` reintroduces the per-layer warm microtask lazy() removes. See the @curlewlabs-com/worker-lazy README.",
      nonStaticDynamicImport:
        "A lazy() loader must use a direct static import specifier. Arbitrary identifiers remain unresolved; concatenation and interpolated templates can synthesize an overbroad glob, and repo-style .js patterns do not resolve their .ts sources. Use a static-specifier thunk map for keyed loading. See the @curlewlabs-com/worker-lazy README.",
      packageDynamicImport:
        "A lazy() loader must import a relative module, not the package '{{specifier}}'. import() resolves to a namespace object, so the package entry becomes a chunk entry point whose ENTIRE export surface is preserved - a barrel that re-exports the library ships the library, and static-edge lint cannot see inside that deferred edge. Give the package one owner leaf that re-exports only what is used, and import that leaf. See the @curlewlabs-com/worker-lazy README.",
    },
  },
  create(context) {
    return {
      /** @param {import('estree').ImportExpression & { parent?: any }} node */
      ImportExpression(node) {
        const arrow = node.parent;
        const call = arrow?.parent;
        const isLoaderShape =
          arrow?.type === "ArrowFunctionExpression" &&
          arrow.body === node &&
          call?.type === "CallExpression" &&
          call.callee?.type === "Identifier" &&
          call.arguments.includes(arrow);
        // The loader must be an argument to the primitive lazy() - not a bare
        // import(), and not a same-named local shadow or a `lazy` from another
        // module (verified by resolving the callee to the @curlewlabs-com/worker-lazy import).
        if (isLoaderShape && isPrimitiveLazyBinding(context, call.callee)) {
          const specifier =
            node.source.type === "Literal" &&
            typeof node.source.value === "string"
              ? node.source.value
              : node.source.type === "TemplateLiteral" &&
                  node.source.expressions.length === 0
                ? (node.source.quasis[0]?.value.cooked ?? null)
                : null;
          if (specifier === null) {
            context.report({ node, messageId: "nonStaticDynamicImport" });
            return;
          }
          // A relative specifier names a module in this tree, which the linker
          // shakes against its importers. A bare specifier names a package, and
          // the package entry it resolves to becomes an un-shakeable chunk entry
          // point instead.
          if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
            context.report({
              node,
              messageId: "packageDynamicImport",
              data: { specifier },
            });
          }
          return;
        }
        context.report({ node, messageId: "bareDynamicImport" });
      },
    };
  },
};

/** @param {any} node */
function unwrapTypeExpression(node) {
  let current = node;
  while (
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
}

// A property's name when the source fixes it: `fetch`, `"fetch"`, or
// `["fetch"]`. A computed key from an expression has no static name.
/** @param {any} prop */
function propertyKeyName(prop) {
  const key = prop.key;
  if (!prop.computed && key?.type === "Identifier") return key.name;
  if (key?.type === "Literal" && typeof key.value === "string")
    return key.value;
  if (key?.type === "TemplateLiteral" && key.expressions.length === 0) {
    return key.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

// The entry shells (fetch/scheduled in the default export, and every method of a
// DurableObject subclass) must stay non-async and await-free: withLazy runs the
// impl synchronously once its module is warm, so a plain shell adds ZERO
// microtasks on the warm path. Marking the shell `async`, or awaiting anywhere
// inside it, reintroduces the per-trigger microtask lazy() was built to remove.
// Scope it with ESLint's `files` to just the shell files, so the modules the
// shells load, with their legitimate `await` inside already-async I/O handlers,
// never trip it.
/** @type {import('eslint').Rule.RuleModule} */
const nonAsyncDispatchShell = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Entry-point dispatch shells (default-export fetch/scheduled, DurableObject methods) must be non-async and await-free so the warm lazy() path adds no microtask.",
    },
    schema: [],
    messages: {
      asyncDispatchShell:
        "The '{{label}}' dispatch shell is async - an async entry wraps the warm path in an extra microtask, defeating lazy()'s zero-overhead warm dispatch. Make it a plain (non-async) shell that returns withLazy(accessor, (m) => m.handler(...)). See the @curlewlabs-com/worker-lazy README.",
      awaitInDispatchShell:
        "A dispatch shell must contain no `await` - awaiting on the warm dispatch path reintroduces the per-trigger microtask lazy() removes. Move all awaited work into the module the shell reaches through lazy(). See the @curlewlabs-com/worker-lazy README.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    // Dispatch-shell function nodes, and every await in the file. A default
    // export can name an object declared above it, so a shell is not known
    // until its export is seen; the awaits are judged once the whole file has
    // been read.
    const dispatchFns = new Set();
    /** @type {any[]} */
    const awaits = [];

    /**
     * @param {any} fnNode the shell's function node
     * @param {string} label the trigger/method name, for the message
     */
    function recordDispatchFn(fnNode, label) {
      dispatchFns.add(fnNode);
      if (fnNode.async) {
        context.report({
          node: fnNode,
          messageId: "asyncDispatchShell",
          data: { label },
        });
      }
    }

    /** @param {any} classNode */
    function isDurableObjectSubclass(classNode) {
      const superClass = classNode?.superClass;
      // `extends DurableObject` or `extends DurableObject<Env>` - the type args
      // ride a sibling node, so the superClass itself is the bare Identifier.
      return (
        superClass?.type === "Identifier" && superClass.name === "DurableObject"
      );
    }

    // The handler object a default export names: an object literal, through
    // any `satisfies` / `as` / `!` wrapping, or an identifier whose
    // declaration initializes it with one.
    /**
     * @param {any} expression
     * @param {any} at a node in the scope the identifier is resolved from
     */
    function handlerObject(expression, at) {
      const node = unwrapTypeExpression(expression);
      if (node?.type === "ObjectExpression") return node;
      if (node?.type !== "Identifier") return null;
      for (
        let scope = /** @type {import('eslint').Scope.Scope | null} */ (
          sourceCode.getScope(at)
        );
        scope;
        scope = scope.upper
      ) {
        const variable = scope.set.get(node.name);
        if (!variable) continue;
        for (const def of variable.defs) {
          if (def.type !== "Variable") continue;
          const init = unwrapTypeExpression(def.node.init);
          if (init?.type === "ObjectExpression") return init;
        }
        return null;
      }
      return null;
    }

    /** @param {any} obj */
    function recordHandlerObject(obj) {
      if (obj === null) return;
      for (const prop of obj.properties) {
        if (prop.type !== "Property") continue;
        const name = propertyKeyName(prop);
        if (name !== "fetch" && name !== "scheduled") continue;
        const fn = prop.value;
        if (
          fn?.type === "FunctionExpression" ||
          fn?.type === "ArrowFunctionExpression"
        ) {
          recordDispatchFn(fn, name);
        }
      }
    }

    return {
      /** @param {any} node */
      ExportDefaultDeclaration(node) {
        recordHandlerObject(handlerObject(node.declaration, node));
      },
      // `export { handler as default }`.
      /** @param {any} node */
      ExportNamedDeclaration(node) {
        if (node.source) return;
        for (const specifier of node.specifiers) {
          const exported =
            specifier.exported?.type === "Identifier"
              ? specifier.exported.name
              : specifier.exported?.value;
          if (exported !== "default") continue;
          recordHandlerObject(handlerObject(specifier.local, node));
        }
      },
      /** @param {any} node */
      MethodDefinition(node) {
        // Only real methods (skip constructor / get / set) on a DO subclass.
        if (node.kind !== "method") return;
        const classNode = node.parent?.parent;
        if (!isDurableObjectSubclass(classNode)) return;
        if (node.value?.type === "FunctionExpression") {
          const label =
            node.key?.type === "Identifier" ? node.key.name : "method";
          recordDispatchFn(node.value, label);
        }
      },
      /** @param {any} node */
      AwaitExpression(node) {
        awaits.push(node);
      },
      "Program:exit"() {
        // An await anywhere lexically inside a dispatch shell (including the
        // withLazy callback, which runs synchronously on the warm path) is a
        // warm-path microtask.
        for (const node of awaits) {
          if (sourceCode.getAncestors(node).some((a) => dispatchFns.has(a))) {
            context.report({ node, messageId: "awaitInDispatchShell" });
          }
        }
      },
    };
  },
};

// no-module-scope-promise-adoption. Workers binds a promise to the I/O context
// of the request that created it, so a request whose only pending work is a
// promise it did not create holds an empty event loop, and the runtime cancels
// it as hung within milliseconds while the creating request returns normally.
//
// The shape this catches is a module-scope slot declared to hold a promise,
// whose value some later caller reads: the classic singleflight. It reads as an
// obvious optimization, and it fails on somebody else's request rather than on
// the one that introduced it.
//
// The ban is on READING the slot as a value, not on declaring it, because that
// is where the hazard lives. It also permits a promise used only as a marker: a
// module-scope promise that nobody but its creator awaits is a correct way to
// bound refresh fan-out, and a rule keyed on the declaration would have to
// exempt it. So a matching binding may be assigned, truthiness-tested,
// compared against null/undefined, and `typeof`-ed; every other reference -
// returned, awaited, `.then`-ed, aliased to a local, passed as an argument,
// read through `?.`, read-modify-written with `??=` - is reported. The safe set
// is enumerated and everything outside it fails closed.
//
// Type-aware by design. Asking the checker rather than pattern-matching the
// annotation is what catches a promise hidden behind a type alias, and what
// lets `WeakMap<object, Promise<T>>` - a gate keyed on the request's own
// context object - pass on its own structure rather than on a named exemption.
//
// The closure-scope and keyed-container gaps are lifetime questions an AST
// cannot answer:
//   - Closure-scope memoizers. A promise-typed binding inside a factory is
//     per-isolate or per-request depending on where the factory is called: the
//     same syntax is the hazard when the factory runs at module scope and
//     correct when it runs inside a handler. lazy() avoids the shape by caching
//     the loaded module, never the in-flight promise, and its own tests hold
//     that.
//   - Keyed containers. A `Map<string, Promise<T>>` at module scope is the
//     hazard in container form, and the type test below does not reach it: a
//     container's properties are its methods. The context-keyed `WeakMap` gate
//     is on the same side of that line, so no type test separates the two.

const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);

/** @param {any} node */
function isNullish(node) {
  if (node.type === "Literal" && node.value === null) return true;
  return node.type === "Identifier" && node.name === "undefined";
}

// The enumerated safe positions. Everything else is a value read, so a form
// this function does not name fails closed (reported) rather than passing.
/**
 * @param {any} identifier a reference to the module-scope binding
 * @returns {boolean}
 */
function isNonValueRead(identifier) {
  const parent = identifier.parent;
  if (parent === undefined || parent === null) return false;

  if (parent.type === "UnaryExpression") {
    return parent.operator === "!" || parent.operator === "typeof";
  }

  if (
    (parent.type === "IfStatement" ||
      parent.type === "WhileStatement" ||
      parent.type === "DoWhileStatement" ||
      parent.type === "ForStatement" ||
      parent.type === "ConditionalExpression") &&
    parent.test === identifier
  ) {
    return true;
  }

  if (
    parent.type === "BinaryExpression" &&
    EQUALITY_OPERATORS.has(parent.operator)
  ) {
    return isNullish(parent.left === identifier ? parent.right : parent.left);
  }

  return false;
}

// Thenable means some union member has a CALLABLE `then`: a resolved record
// with a `then` field of another type is a plain value. The union is split
// because the checker resolves a property on a union only when every member
// has it, so `Promise<T> | undefined` - every optional promise - would
// otherwise read as having no `then` at all.
/**
 * @param {any} checker
 * @param {any} type
 * @param {any} tsNode location the `then` type is resolved at
 * @returns {boolean}
 */
function isThenable(checker, type, tsNode) {
  const constituents = type.isUnion() ? type.types : [type];
  return constituents.some((/** @type {any} */ constituent) => {
    const then = checker.getPropertyOfType(constituent, "then");
    if (then === undefined) return false;
    const thenType = checker.getTypeOfSymbolAtLocation(then, tsNode);
    return checker.getNonNullableType(thenType).getCallSignatures().length > 0;
  });
}

// A type holds a promise if it is thenable, or - one level down - has a
// thenable-typed PROPERTY. One level is what separates a record holding a
// promise (`{ key, promise: Promise<T> }`) from a container parameterized by a
// promise, whose properties are methods.
/**
 * @param {any} checker
 * @param {any} type
 * @param {any} tsNode location the property types are resolved at
 * @returns {boolean}
 */
function holdsPromise(checker, type, tsNode) {
  const constituents = type.isUnion() ? type.types : [type];
  for (const constituent of constituents) {
    if (isThenable(checker, constituent, tsNode)) return true;
    for (const property of checker.getPropertiesOfType(constituent)) {
      const propertyType = checker.getTypeOfSymbolAtLocation(property, tsNode);
      if (isThenable(checker, propertyType, tsNode)) return true;
    }
  }
  return false;
}

// `typeof x` in a type position (`type T = Awaited<typeof x>`) is erased at
// build, so it reads nothing at run time. typescript-eslint records it as a
// value reference, so the AST decides: the identifier, or the head of a
// qualified name (`typeof x.y`), under a TSTypeQuery.
/** @param {any} identifier */
function isInTypeQuery(identifier) {
  let node = identifier.parent;
  while (node?.type === "TSQualifiedName") node = node.parent;
  return node?.type === "TSTypeQuery";
}

/** @type {import('eslint').Rule.RuleModule} */
const noModuleScopePromiseAdoption = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading a module-scope promise binding as a value, which hands one request's promise to another.",
    },
    schema: [],
    messages: {
      promiseAdoption:
        "A request must never adopt a promise another request created: Workers binds a promise to its creator's I/O context, so the adopting request holds an empty event loop and is canceled as hung. Module-scope '{{name}}' may only be assigned, truthiness-tested, or compared against null - never returned, awaited, or aliased. A creator that needs to return its own promise keeps a local reference.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const services = sourceCode.parserServices;
    // The rule is only meaningful with type information; a config that forgets
    // to supply it would silently enforce nothing.
    if (
      services === undefined ||
      services.program === undefined ||
      services.program === null ||
      services.esTreeNodeToTSNodeMap === undefined
    ) {
      throw new Error(
        "no-module-scope-promise-adoption requires type information: set languageOptions.parserOptions.projectService or parserOptions.project for the files this rule runs over.",
      );
    }
    const checker = services.program.getTypeChecker();

    /** @param {any} declaration */
    function checkDeclaration(declaration) {
      for (const variable of sourceCode.getDeclaredVariables(declaration)) {
        const definition = variable.defs[0];
        if (definition === undefined) continue;
        const tsNode = services.esTreeNodeToTSNodeMap.get(definition.name);
        if (tsNode === undefined) continue;
        if (!holdsPromise(checker, checker.getTypeAtLocation(tsNode), tsNode)) {
          continue;
        }
        for (const reference of variable.references) {
          // A plain `x = expr` is a write and nothing else; `x ??= expr` reads
          // as well as writes, and what it reads back is the in-flight promise
          // of whichever request got there first.
          if (!reference.isRead()) continue;
          if (isInTypeQuery(reference.identifier)) continue;
          if (isNonValueRead(reference.identifier)) continue;
          context.report({
            node: reference.identifier,
            messageId: "promiseAdoption",
            data: { name: variable.name },
          });
        }
      }
    }

    return {
      /** @param {any} node */
      "Program:exit"(node) {
        for (const statement of node.body) {
          if (statement.type === "VariableDeclaration") {
            checkDeclaration(statement);
          } else if (
            statement.type === "ExportNamedDeclaration" &&
            statement.declaration?.type === "VariableDeclaration"
          ) {
            checkDeclaration(statement.declaration);
          }
        }
      },
    };
  },
};

const rules = {
  "no-static-value-import": noStaticValueImport,
  "dynamic-import-in-lazy-only": dynamicImportInLazyOnly,
  "non-async-dispatch-shell": nonAsyncDispatchShell,
  "no-module-scope-promise-adoption": noModuleScopePromiseAdoption,
};

export default { rules };
