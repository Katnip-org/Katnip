/**
 * @fileoverview Structured type representation used throughout semantic analysis.
 * Replaces plain strings so parameterized types (list<T>, dict<K,V>) can be inspected.
 */

export type InternalType =
    | { kind: "primitive"; name: "num" | "str" | "bool" | "void" }
    | { kind: "list"; element: InternalType }
    | { kind: "dict"; key: InternalType; value: InternalType }
    | { kind: "tuple"; elements: InternalType[] }
    | { kind: "union"; left: InternalType; right: InternalType }
    | { kind: "enum"; name: string }
    | { kind: "typevar"; name: string } // stdlib-only placeholder (T, K, V), substituted before checks
    | { kind: "unknown" };

export function isAssignable(from: InternalType, to: InternalType): boolean {
    if (from.kind === "unknown" || to.kind === "unknown") return true;
    // Typevars are substituted away before assignability runs; a stray one
    // degrades to unknown-like behavior instead of a false error.
    if (from.kind === "typevar" || to.kind === "typevar") return true;
    if (from.kind === "union")
        return isAssignable(from.left, to) && isAssignable(from.right, to);
    if (to.kind === "union")
        return isAssignable(from, to.left) || isAssignable(from, to.right);
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

/** Bindings accumulated while matching a receiver against a stdlib `self` parameter. */
export type TypevarBindings = Map<string, InternalType>;

/** Replaces typevars with their bindings; unbound typevars become `unknown`. */
export function substitute(type: InternalType, bindings: TypevarBindings): InternalType {
    switch (type.kind) {
        case "typevar": return bindings.get(type.name) ?? { kind: "unknown" };
        case "list": return { kind: "list", element: substitute(type.element, bindings) };
        case "dict": return { kind: "dict", key: substitute(type.key, bindings), value: substitute(type.value, bindings) };
        case "tuple": return { kind: "tuple", elements: type.elements.map((e) => substitute(e, bindings)) };
        case "union": return { kind: "union", left: substitute(type.left, bindings), right: substitute(type.right, bindings) };
        default: return type;
    }
}

/**
 * Structurally matches a receiver's type against a stdlib `self` parameter type,
 * binding typevars along the way (list<T> vs list<num> binds T := num).
 * @returns false when the shapes are incompatible, so the overload can be skipped.
 */
export function bindReceiver(
    param: InternalType,
    receiver: InternalType,
    bindings: TypevarBindings,
): boolean {
    if (param.kind === "typevar") {
        const previous = bindings.get(param.name);
        if (previous) return isAssignable(receiver, previous) && isAssignable(previous, receiver);
        bindings.set(param.name, receiver);
        return true;
    }
    if (receiver.kind === "unknown") return true; // untyped receiver: accept, bind nothing
    if (param.kind !== receiver.kind) return false;

    switch (param.kind) {
        case "primitive": return param.name === (receiver as typeof param).name;
        case "enum": return param.name === (receiver as typeof param).name;
        case "list": return bindReceiver(param.element, (receiver as typeof param).element, bindings);
        case "dict": {
            const r = receiver as typeof param;
            return bindReceiver(param.key, r.key, bindings) && bindReceiver(param.value, r.value, bindings);
        }
        case "tuple": {
            const r = receiver as typeof param;
            return (
                param.elements.length === r.elements.length &&
                param.elements.every((e, i) => bindReceiver(e, r.elements[i], bindings))
            );
        }
        default: return true;
    }
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
        case "typevar": return type.name;
        case "unknown": return "unknown";
        default: {
            const _exhaustive: never = type;
            return _exhaustive;
        }
    }
}