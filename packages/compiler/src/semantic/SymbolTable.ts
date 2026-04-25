/**
 * @fileoverview Contains all the symbolTable interfaces for the Katnip semantic analysis stage
 */

export interface Scope {
    [name: string]: ScopeEntry;
}

export type ScopeEntry = 
    | VariableSymbol
    | EnumSymbol
    | FunctionSymbol

export interface VariableSymbol {
    type: string;
}

export interface EnumSymbol {
    members: string[];
}

export interface FunctionParameter {
    type: string;
}

export interface FunctionSymbol {
    params: Record<string, string>;
    returnType: string;
}