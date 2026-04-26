/**
 * @fileoverview Contains all the symbolTable interfaces for the Katnip semantic analysis stage
 */

import type { InternalType } from "./InternalType.js";
import type { VariableDeclarationType } from "../parser/AST-nodes.js";

export interface Scope {
    [name: string]: ScopeEntry;
}

export type ScopeEntry =
    | VariableSymbol
    | EnumSymbol
    | FunctionSymbol
    | SpriteSymbol

export interface SpriteSymbol {
    kind: "sprite";
    props: Record<string, InternalType>;
}

export interface VariableSymbol {
    kind: "variable";
    type: InternalType;
    access: VariableDeclarationType;
}

export interface EnumSymbol {
    kind: "enum";
    members: string[];
}

export interface FunctionParameter {
    name: string;
    type: InternalType;
}

export interface FunctionSymbol {
    kind: "function";
    params: FunctionParameter[];
    returnType: InternalType;
}
