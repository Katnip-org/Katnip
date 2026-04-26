/**
 * @fileoverview Structured type representation used throughout semantic analysis.
 * Replaces plain strings so parameterized types (list<T>, dict<K,V>) can be inspected.
 */

import type { TypeNode } from "../parser/AST-nodes.js";

export type InternalType =
    | { kind: "primitive"; name: "num" | "str" | "bool" | "void" }
    | { kind: "list";      element: InternalType }
    | { kind: "dict";      key: InternalType; value: InternalType }
    | { kind: "tuple";     elements: InternalType[] }
    | { kind: "union";     left: InternalType; right: InternalType }
    | { kind: "enum";      name: string }
    | { kind: "typevar";   name: string }
    | { kind: "literal";   value: string | number }
    | { kind: "unknown" }

export const UNKNOWN: InternalType = { kind: "unknown" };

/**
 * Converts an InternalType to a string repr for error msgs.
 * @param t - The type to display.
 * @returns A display string like "num", "list<str>", "num | str".
 */
export function toDisplayString(t: InternalType): string {
    switch (t.kind) {
        case "primitive": return t.name;
        case "list":      return `list<${toDisplayString(t.element)}>`;
        case "dict":      return `dict<${toDisplayString(t.key)}, ${toDisplayString(t.value)}>`;
        case "tuple":     return `(${t.elements.map(toDisplayString).join(", ")})`;
        case "union":     return `${toDisplayString(t.left)} | ${toDisplayString(t.right)}`;
        case "enum":      return t.name;
        case "typevar":   return t.name;
        case "literal":   return JSON.stringify(t.value);
        case "unknown":   return "?";
    }
}

/**
 * Returns true if types a and b are structurally compatible.
 * unknown is compatible with everything; unions are checked member-wise.
 * @param a - The expected type.
 * @param b - The actual type.
 */
export function typesCompatible(a: InternalType, b: InternalType): boolean {
    if (a.kind === "unknown" || b.kind === "unknown") return true;
    if (a.kind === "typevar" || b.kind === "typevar") return true;
    if (a.kind === "union") return typesCompatible(a.left, b) || typesCompatible(a.right, b);
    if (b.kind === "union") return typesCompatible(a, b.left) || typesCompatible(a, b.right);
    if (a.kind === "literal" && b.kind === "literal") return a.value === b.value;
    if (a.kind === "literal" && b.kind === "primitive") return (typeof a.value === "string" && b.name === "str") || (typeof a.value === "number" && b.name === "num");
    if (b.kind === "literal" && a.kind === "primitive")
        return (typeof b.value === "string" && a.name === "str") || (typeof b.value === "number" && a.name === "num");
    if (a.kind !== b.kind) return false;

    switch (a.kind) {
        case "primitive": return a.name === (b as typeof a).name;
        case "list":      return typesCompatible(a.element, (b as typeof a).element);
        case "dict": {
            const bd = b as typeof a;
            return typesCompatible(a.key, bd.key) && typesCompatible(a.value, bd.value);
        }
        case "tuple": {
            const bt = b as typeof a;
            return a.elements.length === bt.elements.length &&
                a.elements.every((e, i) => typesCompatible(e, bt.elements[i]));
        }
        case "enum": return a.name === (b as typeof a).name;
        default:     return false;
    }
}

/**
 * Converts a parser TypeNode into an InternalType.
 * @param node - The AST type node.
 * @returns The equivalent InternalType.
 */
export function typeNodeToInternalType(node: TypeNode): InternalType {
    if (node.type === "UnionType") {
        return { kind: "union", left: typeNodeToInternalType(node.left), right: typeNodeToInternalType(node.right) };
    }

    switch (node.typeName) {
        case "num":  return { kind: "primitive", name: "num" };
        case "str":  return { kind: "primitive", name: "str" };
        case "bool": return { kind: "primitive", name: "bool" };
        case "void": return { kind: "primitive", name: "void" };
        case "list": {
            const element = node.typeParams?.[0] ? typeNodeToInternalType(node.typeParams[0]) : UNKNOWN;
            return { kind: "list", element };
        }
        case "dict": {
            const key   = node.typeParams?.[0] ? typeNodeToInternalType(node.typeParams[0]) : UNKNOWN;
            const value = node.typeParams?.[1] ? typeNodeToInternalType(node.typeParams[1]) : UNKNOWN;
            return { kind: "dict", key, value };
        }
        case "nestedList": {
            const element = node.typeParams?.[0] ? typeNodeToInternalType(node.typeParams[0]) : UNKNOWN;
            return { kind: "list", element: { kind: "list", element } };
        }
        default:
            return { kind: "enum", name: node.typeName };
    }
}

/**
 * Walks a pattern InternalType against an actual InternalType, binding any typevar names.
 * Mutates the provided bindings record.
 * @param pattern - The type that may contain typevars.
 * @param actual  - The concrete type to match against.
 * @param bindings - The record to populate with typevar → type mappings.
 */
export function bindTypeVars(pattern: InternalType, actual: InternalType, bindings: Record<string, InternalType>): void {
    if (pattern.kind === "typevar") {
        if (!(pattern.name in bindings)) bindings[pattern.name] = actual;
        return;
    }
    if (pattern.kind !== actual.kind) return;

    switch (pattern.kind) {
        case "list":
            bindTypeVars(pattern.element, (actual as typeof pattern).element, bindings);
            break;
        case "dict": {
            const a = actual as typeof pattern;
            bindTypeVars(pattern.key, a.key, bindings);
            bindTypeVars(pattern.value, a.value, bindings);
            break;
        }
        case "tuple": {
            const a = actual as typeof pattern;
            pattern.elements.forEach((e, i) => {
                if (i < a.elements.length) bindTypeVars(e, a.elements[i], bindings);
            });
            break;
        }
    }
}

/**
 * Recursively replaces typevars in a type with their bound values.
 * @param type     - The type potentially containing typevars.
 * @param bindings - The typevar → type mapping from bindTypeVars.
 * @returns The concrete type with all typevars substituted.
 */
export function substituteTypeVars(type: InternalType, bindings: Record<string, InternalType>): InternalType {
    switch (type.kind) {
        case "typevar": return bindings[type.name] ?? UNKNOWN;
        case "list":    return { kind: "list",  element: substituteTypeVars(type.element, bindings) };
        case "dict":    return { kind: "dict",  key: substituteTypeVars(type.key, bindings), value: substituteTypeVars(type.value, bindings) };
        case "tuple":   return { kind: "tuple", elements: type.elements.map(e => substituteTypeVars(e, bindings)) };
        case "union":   return { kind: "union", left: substituteTypeVars(type.left, bindings), right: substituteTypeVars(type.right, bindings) };
        default:        return type;
    }
}
