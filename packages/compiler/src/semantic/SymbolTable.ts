import type {
    DecoratorNode,
    EnumMemberNode,
    ExpressionNode,
    NodeBase,
    ParameterNode,
    StructFieldNode,
    TypeNode,
    VariableDeclarationType,
} from "../parser/AST-nodes.js";
import type { InternalType } from "./InternalTypes.js";

/**
 * How a call to this proc is emitted by the lowering pass.
 * "builds" procs have no opcode of their own: their body is a single `return <expr>`
 * that the IR inlines at each use site, composing existing Scratch reporters.
 */
export type LoweringKind = "reporter" | "command" | "yields" | "userproc" | "builds";

/** Shape of a proc's return frame. Multi-size (list) returns are not supported yet. */
export type ReturnMethod =
    | { kind: "void" }
    | { kind: "scalar" }
    | { kind: "tuple"; width: number };

/** Codegen-relevant metadata extracted from a procedure's decorators. */
export interface SignatureMeta {
    /** Scratch opcode this builtin lowers to (@opcode). */
    opcode?: string;
    /** Whether this is a hat block, usable only as an event handler (@hat). */
    hat?: boolean;
    /** Whether the proc runs without screen refresh (@warp). */
    warp?: boolean;
    /** Emission strategy (@lower), defaulted from opcode/return shape when absent. */
    lower?: LoweringKind;
    /** Binary operator this proc backs (@operator), e.g. "!&". Only meaningful with @lower = "builds". */
    operator?: string;
    /** Custom block label (@proccode); one %placeholder per param, in declaration order. */
    proccode?: string;
    /** The `return` expression of a @lower = "builds" proc, inlined by the IR at each use site. */
    buildsExpr?: ExpressionNode;
    /** Requested return strategy (@ret), default "auto". */
    ret?: "auto" | "var" | "vstack";
    /** Strategy after cycle analysis: "var" iff the proc is in no call cycle. */
    retResolved?: "var" | "vstack";
    /** Return frame shape derived from the declared return type. */
    returns?: ReturnMethod;
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
    members: EnumMemberNode[];
}
export interface StructSymbol extends SymbolBase {
    kind: "struct";
    fields: StructFieldNode[];
}
export interface SpriteSymbol extends SymbolBase {
    kind: "sprite";
}
/** A stdlib namespace (motion.*, list.*, ...): one per stdlib file. */
export interface NamespaceSymbol extends SymbolBase {
    kind: "namespace";
    scope: Scope;
}
export type SymbolEntry = VariableSymbol | ProcedureSymbol | EnumSymbol | StructSymbol | SpriteSymbol | NamespaceSymbol;


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

    entries(): ReadonlyMap<string, SymbolEntry[]> {
        return this.symbols;
    }

    lookupLocal(name: string): SymbolEntry[] | null {
        return this.symbols.get(name) ?? null; // for duplicate checks
    }

    lookup(name: string): SymbolEntry[] | null {
        return this.symbols.get(name) ?? this.parent?.lookup(name) ?? null;
    }
}