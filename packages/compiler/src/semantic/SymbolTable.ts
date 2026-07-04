import type {
    DecoratorNode,
    NodeBase,
    ParameterNode,
    TypeNode,
    VariableDeclarationType,
} from "../parser/AST-nodes.js";
import type { InternalType } from "./InternalTypes.js";

/** Codegen-relevant metadata extracted from a procedure's decorators. */
export interface SignatureMeta {
    /** Scratch opcode this builtin lowers to (@opcode). */
    opcode?: string;
    /** Whether this is a hat block, usable only as an event handler (@hat). */
    hat?: boolean;
}

/** One overload of a procedure: its parameter list and declared return type. */
export interface Signature {
    params: ParameterNode[];
    returnType: TypeNode | null;
    resolvedParamTypes?: InternalType[]; // TypeNodes from stdlib should never reach typeFromNode
    resolvedReturn?: InternalType;
    meta?: SignatureMeta;
    decorators?: DecoratorNode[];
}

export interface SymbolBase {
    name: string;
    declNode: NodeBase;
    /**
     * Resolved type of this symbol, cached lazily by the analyzer so it is
     * computed once instead of on every lookup:
     * - variable / parameter / loopVar -> the value's type (from its annotation, or inferred from the initializer / iterable)
     * - enum -> { kind: "enum", name }
     * Stays undefined until first resolved; procedures and sprites have no value type.
     */
    cachedType?: InternalType;
}
export interface VariableSymbol extends SymbolBase {
    kind: "variable" | "parameter" | "loopVar"; // Loopvar => variables created by for loops
    type: TypeNode | null;
    access?: VariableDeclarationType;
}
export interface ProcedureSymbol extends SymbolBase {
    kind: "procedure";
    signatures: Signature[]; // overloads
    otherDeclNodes?: NodeBase[];
}
export interface EnumSymbol extends SymbolBase {
    kind: "enum";
    members: (string | number)[];
}
export interface SpriteSymbol extends SymbolBase {
    kind: "sprite";
}
/** A stdlib namespace (motion.*, list.*, ...): one per stdlib file. */
export interface NamespaceSymbol extends SymbolBase {
    kind: "namespace";
    scope: Scope;
}
export type SymbolEntry = VariableSymbol | ProcedureSymbol | EnumSymbol | SpriteSymbol | NamespaceSymbol;


export type ScopeKind = "stdlib" | "namespace" | "global" | "sprite" | "procedure" | "block";

export class Scope {
    private symbols = new Map<string, SymbolEntry[]>();

    constructor(
        public readonly kind: ScopeKind,
        public readonly parent: Scope | null = null,
    ) {}

    /** Returns null on success, or the conflicting symbols on illegal redeclaration. */
    declare(sym: SymbolEntry): SymbolEntry[] | null {
        const existing = this.symbols.get(sym.name);
        if (existing) {
            const overloadable =
                sym.kind === "procedure" &&
                existing.every((s) => s.kind === "procedure");
            if (!overloadable) return existing; // redeclaration error
        }
        this.symbols.set(sym.name, [...(existing ?? []), sym]);
        return null;
    }

    lookupLocal(name: string): SymbolEntry[] | null {
        return this.symbols.get(name) ?? null; // for duplicate checks
    }

    lookup(name: string): SymbolEntry[] | null {
        return this.symbols.get(name) ?? this.parent?.lookup(name) ?? null;
    }
}