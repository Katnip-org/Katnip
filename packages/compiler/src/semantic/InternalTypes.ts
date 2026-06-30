/**
 * @fileoverview Structured type representation used throughout semantic analysis.
 * Replaces plain strings so parameterized types (list<T>, dict<K,V>) can be inspected.
 */

import type { TypeNode } from "../parser/AST-nodes.js";

export type InternalType =
    | { kind: "primitive"; name: "num" | "str" | "bool" | "void" }
    | { kind: "list"; element: InternalType }
    | { kind: "dict"; key: InternalType; value: InternalType }
    | { kind: "tuple"; elements: InternalType[] }
    | { kind: "union"; left: InternalType; right: InternalType }
    | { kind: "enum"; name: string }
    | { kind: "unknown" };

export function isAssignable(from: InternalType, to: InternalType): boolean {
    if (from.kind === "unknown" || to.kind === "unknown") return true;
    if (to.kind === "union")
        return isAssignable(from, to.left) || isAssignable(from, to.right);
    if (from.kind === "union")
        return isAssignable(from.left, to) && isAssignable(from.right, to);
    if (from.kind !== to.kind) return false;

    const toAny = to as any;
    switch (from.kind) {
        case "primitive": return from.name === toAny.name;
        case "list": return isAssignable(from.element, toAny.element);
        case "dict": return (isAssignable(from.key, toAny.key) && isAssignable(from.value, toAny.value));
        case "tuple": return (from.elements.length === toAny.elements.length && from.elements.every((t, i) => isAssignable(t, toAny.elements[i])));
        case "enum": return from.name === toAny.name;
    }

    return false;
}

export function isStr(type: InternalType): boolean {
    if (type.kind !== "primitive") return false;
    if (type.name === "str") return true;
    return false;
}

export function typeToString(type: InternalType): string {
    switch (type.kind) {
        case "primitive": return type.name;
        case "list": return `list<${typeToString(type.element)}>`;
        case "dict": return `dict<${typeToString(type.key)}: ${typeToString(type.value)}>`;
        case "tuple": return `(${type.elements.map(typeToString).join(", ")})`;
        case "union": return `${typeToString(type.left)} | ${typeToString(type.right)}`;
        case "enum": return type.name;
        case "unknown": return "unknown";
        default: {
            const _exhaustive: never = type;
            return _exhaustive;
        }
    }
}