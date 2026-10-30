/**
 * @fileoverview Reverse of the stdlib: opcode -> the .knip call that emits it.
 * The compiler's analyzer builds the table, so a new `@opcode` proc decompiles with no change here.
 */

import { isAssignable, type InternalType } from "../semantic/InternalTypes.js";
import { SemanticAnalyzer } from "../semantic/SemanticAnalyzer.js";
import { loadStdlibModules } from "../semantic/StdlibLoader.js";
import type { StdlibBlock } from "../semantic/SymbolTable.js";
import { ErrorReporter } from "../utils/ErrorReporter.js";

export type { StdlibBlock } from "../semantic/SymbolTable.js";
export type StdlibParam = StdlibBlock["params"][number];

/** The decompiler's view of a value's type: just enough to know when a cast is needed. */
export type Ty = "num" | "str" | "bool" | "any";

export interface StdlibTable {
    byOpcode: ReadonlyMap<string, StdlibBlock>;
    /** Namespaces and prelude globals; a Scratch name spelled like one would shadow it. */
    names: ReadonlySet<string>;
}

let table: StdlibTable | null = null;

export function stdlibTable(): StdlibTable {
    if (table) return table;

    const modules = loadStdlibModules();
    const analyzer = new SemanticAnalyzer(new ErrorReporter(""));
    analyzer.loadStdlib(modules);

    const names = new Set([
        ...modules.map((m) => m.namespace),
        ...modules
            .filter((m) => m.namespace === "prelude")
            .flatMap((m) => m.ast.body.map((stmt) => ("name" in stmt && typeof stmt.name === "string" ? stmt.name : "")))
            .filter(Boolean),
    ]);
    table = { byOpcode: analyzer.stdlibBlocks, names };
    return table;
}

/** Enums, unions and generics take anything, so only a lone primitive needs a cast. */
export function tyOf(type: InternalType): Ty {
    if (type.kind === "primitive" && type.name !== "void") return type.name;
    return "any";
}

/** Whether a param takes plain text, so a dropdown value no enum member holds can be passed as a string. */
export function takesText(type: InternalType): boolean {
    return isAssignable({ kind: "primitive", name: "str" }, type);
}
