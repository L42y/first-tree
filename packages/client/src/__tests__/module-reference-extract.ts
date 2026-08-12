/**
 * Shared AST module-edge extraction for Client boundary guards.
 * Fail-closed on unclassifiable / non-literal loads; covers ESM, dynamic
 * import, ImportEquals, require, and createRequire binder forms.
 */
import ts from "typescript";

export function isDynamicImportCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/** String / no-substitution template literal module specifier, or null. */
export function literalModuleSpecifierText(node: ts.Expression | ts.LiteralTypeNode["literal"]): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

/**
 * AST-level module references: ImportDeclaration (including bare
 * side-effect), ExportDeclaration re-exports, dynamic `import()`,
 * `import("…")` type queries (`ImportTypeNode`), external
 * `import x = require("…")` (`ImportEqualsDeclaration`), and executable
 * CommonJS loader calls — `require("…")`, immediate
 * `createRequire(…)("…")`, namespace `module.createRequire(…)("…")`,
 * namespace-destructured aliases
 * (`const { "createRequire": makeRequire } = ns`), aliased binders, and
 * simple binder propagation (`const load = req`).
 * Direct binder calls are classified; `req.resolve(…)` package lookups are
 * not treated as module-edge loads. Unsupported createRequire shapes /
 * non-literal / unclassifiable forms are recorded so the production scan
 * fails closed instead of silently skipping them.
 */
export function extractModuleReferences(source: string): {
  literalSpecifiers: string[];
  hasUnresolvableModuleReference: boolean;
} {
  const sourceFile = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literalSpecifiers: string[] = [];
  let hasUnresolvableModuleReference = false;

  // Names that bind `createRequire` (import rename / local alias).
  const createRequireNames = new Set<string>(["createRequire"]);
  // `import * as ns from "node:module"` — `ns.createRequire` is supported.
  const nodeModuleNamespaces = new Set<string>();
  // Identifiers holding the function returned by `createRequire(...)`.
  // Free `require` is a binder source so `const load = require` propagates.
  const requireBinders = new Set<string>(["require"]);

  function isNodeModuleSpecifier(spec: string): boolean {
    return spec === "node:module" || spec === "module";
  }

  function recordLoaderSpecifier(arg: ts.Expression | undefined): void {
    if (!arg) {
      hasUnresolvableModuleReference = true;
      return;
    }
    const text = literalModuleSpecifierText(arg);
    if (text !== null) literalSpecifiers.push(text);
    else hasUnresolvableModuleReference = true;
  }

  function isNamespaceCreateRequireProp(expr: ts.Expression): boolean {
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === "createRequire") {
      return ts.isIdentifier(expr.expression) && nodeModuleNamespaces.has(expr.expression.text);
    }
    if (
      ts.isElementAccessExpression(expr) &&
      expr.argumentExpression &&
      ts.isStringLiteralLike(expr.argumentExpression) &&
      expr.argumentExpression.text === "createRequire"
    ) {
      return ts.isIdentifier(expr.expression) && nodeModuleNamespaces.has(expr.expression.text);
    }
    return false;
  }

  /** Any `*.createRequire` / `*["createRequire"]` access, tracked or not. */
  function isCreateRequirePropertyAccess(expr: ts.Expression): boolean {
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === "createRequire") return true;
    if (
      ts.isElementAccessExpression(expr) &&
      expr.argumentExpression &&
      ts.isStringLiteralLike(expr.argumentExpression) &&
      expr.argumentExpression.text === "createRequire"
    ) {
      return true;
    }
    return false;
  }

  /**
   * Classify a `*.createRequire` property/element access:
   * - tracked `import * as ns from "node:module"` receiver → supported
   * - any other receiver → unsupported escape (fail closed)
   */
  function classifyCreateRequirePropertyAccess(expr: ts.Expression): "tracked" | "untracked" | false {
    if (!isCreateRequirePropertyAccess(expr)) return false;
    return isNamespaceCreateRequireProp(expr) ? "tracked" : "untracked";
  }

  /**
   * `true` = known createRequire callee; `"unresolvable"` = `*.createRequire`
   * form that is not a tracked node:module namespace (fail closed);
   * `false` = not a createRequire callee.
   */
  function classifyCreateRequireCallee(expr: ts.Expression): true | false | "unresolvable" {
    if (ts.isIdentifier(expr) && createRequireNames.has(expr.text)) return true;
    const prop = classifyCreateRequirePropertyAccess(expr);
    if (prop === "tracked") return true;
    if (prop === "untracked") return "unresolvable";
    return false;
  }

  function isCreateRequireCall(expr: ts.Expression): boolean {
    return ts.isCallExpression(expr) && classifyCreateRequireCallee(expr.expression) === true;
  }

  function isRequireBinderAlias(expr: ts.Expression): boolean {
    return ts.isIdentifier(expr) && requireBinders.has(expr.text);
  }

  function isKnownBinderOrFactoryName(name: string): boolean {
    return requireBinders.has(name) || createRequireNames.has(name);
  }

  /**
   * Allowed uses of a known binder/factory identifier: direct call,
   * simple `const x = id` / `x = id` aliasing, and binder `.resolve` package
   * lookup. Any other reference (argument, property storage, destructure)
   * is an unsupported escape → fail closed.
   */
  function isAllowedBinderOrFactoryUse(id: ts.Identifier): boolean {
    const parent = id.parent;
    if (!parent) return false;
    // `import { createRequire }` / `import { createRequire as cr }`
    if (ts.isImportSpecifier(parent) && (parent.name === id || parent.propertyName === id)) return true;
    // `const { "createRequire": makeRequire } = ns` — local binding name is not an escape.
    if (ts.isBindingElement(parent) && parent.name === id) return true;
    // Binding site: `const req = …` / `load = …` — the name itself is not an escape.
    if (ts.isVariableDeclaration(parent) && parent.name === id) return true;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === id &&
      ts.isIdentifier(parent.left)
    ) {
      return true;
    }
    if (ts.isCallExpression(parent) && parent.expression === id) return true;
    if (ts.isVariableDeclaration(parent) && parent.initializer === id && ts.isIdentifier(parent.name)) return true;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === id &&
      ts.isIdentifier(parent.left)
    ) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === id &&
      parent.name.text === "resolve" &&
      requireBinders.has(id.text)
    ) {
      return true;
    }
    // Property-name token (`obj.createRequire`) is not a value reference to
    // the `createRequire` binding; namespace forms are handled separately.
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
    return false;
  }

  function isAllowedNamespaceCreateRequireUse(prop: ts.Expression): boolean {
    const parent = prop.parent;
    if (!parent) return false;
    if (ts.isCallExpression(parent) && parent.expression === prop) return true;
    if (ts.isVariableDeclaration(parent) && parent.initializer === prop && ts.isIdentifier(parent.name)) return true;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === prop &&
      ts.isIdentifier(parent.left)
    ) {
      return true;
    }
    return false;
  }

  function bindingElementSourceProp(el: ts.BindingElement): string | null {
    if (el.propertyName) {
      if (ts.isIdentifier(el.propertyName)) return el.propertyName.text;
      // `const { "createRequire": makeRequire } = ns`
      if (ts.isStringLiteralLike(el.propertyName)) return el.propertyName.text;
      return null;
    }
    return ts.isIdentifier(el.name) ? el.name.text : null;
  }

  /**
   * `const { createRequire: makeRequire } = ns` /
   * `const { "createRequire": makeRequire } = ns` /
   * `const { createRequire } = ns` from a tracked
   * `import * as ns from "node:module"`. Any other destructure of
   * `createRequire` (unknown receiver, nested pattern, non-identifier local,
   * computed property name) fails closed.
   */
  function recordDestructuredCreateRequire(el: ts.BindingElement, init: ts.Expression): void {
    const sourceProp = bindingElementSourceProp(el);
    if (sourceProp === "createRequire") {
      if (!ts.isIdentifier(el.name)) {
        hasUnresolvableModuleReference = true;
        return;
      }
      if (ts.isIdentifier(init) && nodeModuleNamespaces.has(init.text)) {
        createRequireNames.add(el.name.text);
        return;
      }
      hasUnresolvableModuleReference = true;
      return;
    }
    // Nested / computed binding patterns that might hide createRequire.
    if (ts.isObjectBindingPattern(el.name) || ts.isArrayBindingPattern(el.name)) {
      const nestedText = el.name.getText(sourceFile);
      if (/\bcreateRequire\b/.test(nestedText)) {
        hasUnresolvableModuleReference = true;
      }
    } else if (
      el.propertyName &&
      !ts.isIdentifier(el.propertyName) &&
      !ts.isStringLiteralLike(el.propertyName) &&
      /\bcreateRequire\b/.test(el.getText(sourceFile))
    ) {
      // Computed property name (`[createRequire]` / `[expr]`) — fail closed.
      hasUnresolvableModuleReference = true;
    }
  }

  function recordFactoryOrBinderFromInit(name: string, init: ts.Expression): void {
    if (isCreateRequireCall(init) || isRequireBinderAlias(init)) {
      requireBinders.add(name);
    } else if (ts.isIdentifier(init) && createRequireNames.has(init.text)) {
      createRequireNames.add(name);
    } else if (isNamespaceCreateRequireProp(init)) {
      // Tracked namespace factory property alias: `const cr = ns.createRequire`
      createRequireNames.add(name);
    } else if (isCreateRequirePropertyAccess(init)) {
      // Untracked receiver property alias (default import / dynamic import / unknown)
      hasUnresolvableModuleReference = true;
    } else if (ts.isCallExpression(init) && classifyCreateRequireCallee(init.expression) === "unresolvable") {
      hasUnresolvableModuleReference = true;
    }
  }

  // Pass 1: collect namespaces, createRequire aliases, binders, and binder aliases.
  // Fixed-point so `const load = req` after `const req = createRequire(...)` propagates.
  function collectOnce(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (node.importClause?.namedBindings) {
        if (ts.isNamedImports(node.importClause.namedBindings)) {
          for (const el of node.importClause.namedBindings.elements) {
            if ((el.propertyName?.text ?? el.name.text) === "createRequire") {
              createRequireNames.add(el.name.text);
            }
          }
        } else if (ts.isNamespaceImport(node.importClause.namedBindings) && isNodeModuleSpecifier(spec)) {
          nodeModuleNamespaces.add(node.importClause.namedBindings.name.text);
        }
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      if (ts.isIdentifier(node.name)) {
        recordFactoryOrBinderFromInit(node.name.text, init);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          if (ts.isOmittedExpression(el)) continue;
          recordDestructuredCreateRequire(el, init);
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      recordFactoryOrBinderFromInit(node.left.text, node.right);
    }
    ts.forEachChild(node, collectOnce);
  }

  let prevBinderCount = -1;
  let prevFactoryCount = -1;
  let prevNsCount = -1;
  while (
    requireBinders.size !== prevBinderCount ||
    createRequireNames.size !== prevFactoryCount ||
    nodeModuleNamespaces.size !== prevNsCount
  ) {
    prevBinderCount = requireBinders.size;
    prevFactoryCount = createRequireNames.size;
    prevNsCount = nodeModuleNamespaces.size;
    collectOnce(sourceFile);
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      literalSpecifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      literalSpecifiers.push(node.moduleSpecifier.text);
    } else if (isDynamicImportCall(node)) {
      const [arg] = node.arguments;
      const text = arg ? literalModuleSpecifierText(arg) : null;
      if (text !== null) literalSpecifiers.push(text);
      else hasUnresolvableModuleReference = true;
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) {
        const text = literalModuleSpecifierText(node.argument.literal);
        if (text !== null) literalSpecifiers.push(text);
        else hasUnresolvableModuleReference = true;
      } else {
        hasUnresolvableModuleReference = true;
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const text = literalModuleSpecifierText(node.moduleReference.expression);
        if (text !== null) literalSpecifiers.push(text);
        else hasUnresolvableModuleReference = true;
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isCallExpression(callee)) {
        const kind = classifyCreateRequireCallee(callee.expression);
        if (kind === true) {
          recordLoaderSpecifier(node.arguments[0]);
        } else if (kind === "unresolvable") {
          hasUnresolvableModuleReference = true;
        }
      } else if (ts.isIdentifier(callee) && requireBinders.has(callee.text)) {
        recordLoaderSpecifier(node.arguments[0]);
      } else if (ts.isIdentifier(callee) && createRequireNames.has(callee.text)) {
        // Bare `createRequire(url)` factory call — not a module load by itself.
      } else {
        const kind = classifyCreateRequireCallee(callee);
        if (kind === "unresolvable") hasUnresolvableModuleReference = true;
      }
      for (const arg of node.arguments) {
        if (ts.isIdentifier(arg) && isKnownBinderOrFactoryName(arg.text)) {
          hasUnresolvableModuleReference = true;
        }
      }
    } else if (ts.isIdentifier(node) && isKnownBinderOrFactoryName(node.text)) {
      if (!isAllowedBinderOrFactoryUse(node)) {
        hasUnresolvableModuleReference = true;
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const prop = classifyCreateRequirePropertyAccess(node);
      if (prop === "tracked") {
        if (!isAllowedNamespaceCreateRequireUse(node)) {
          hasUnresolvableModuleReference = true;
        }
      } else if (prop === "untracked") {
        // Untracked receiver `*.createRequire` — direct call or property alias.
        hasUnresolvableModuleReference = true;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { literalSpecifiers, hasUnresolvableModuleReference };
}
