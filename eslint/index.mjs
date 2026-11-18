// @ts-check
// ESLint rules that keep a Worker's module loading deferred. `lazy()` /
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

const rules = {
  "no-static-value-import": noStaticValueImport,
  "dynamic-import-in-lazy-only": dynamicImportInLazyOnly,
  "non-async-dispatch-shell": nonAsyncDispatchShell,
};

export default { rules };
