// @ts-check
// The no-module-scope-promise-adoption ESLint rule: a module-scope binding whose
// type holds a promise may be assigned and tested, never read as a value,
// because a request that awaits a promise another request created is canceled
// as hung. index.mjs registers it beside the deferred-loading rules; unlike
// them it needs type information.
//
// Workers binds a promise to the I/O context of the request that created it,
// so a request whose only pending work is a promise it did not create holds an
// empty event loop, and the runtime cancels it as hung within milliseconds
// while the creating request returns normally.
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

    /** @param {any} variable */
    function checkVariable(variable) {
      const definition = variable.defs[0];
      if (definition === undefined) return;
      const tsNode = services.esTreeNodeToTSNodeMap.get(definition.name);
      if (tsNode === undefined) return;
      if (!holdsPromise(checker, checker.getTypeAtLocation(tsNode), tsNode)) {
        return;
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

    return {
      /** @param {any} node */
      "Program:exit"(node) {
        // The variables that live as long as the module are the module
        // scope's (the global scope's, in a script), whatever statement
        // declares them: a `var` nested in a top-level block is hoisted there
        // too. Imports are not judged here; the README lists that limit.
        const globalScope = sourceCode.getScope(node);
        const moduleScope =
          globalScope.childScopes.find(
            (/** @type {any} */ scope) => scope.type === "module",
          ) ?? globalScope;
        for (const variable of moduleScope.variables) {
          const kind = variable.defs[0]?.type;
          if (kind !== "Variable") continue;
          checkVariable(variable);
        }
      },
    };
  },
};

export default noModuleScopePromiseAdoption;
