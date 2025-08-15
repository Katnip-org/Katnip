/**
 * @fileoverview Contains the token interfaces for the Katnip lexer.
 */

const valuedTokenTypes = [
    // Literals
    "String",
    "InterpolatedString", // e.g. f"Hello, {name.uppercase()}!"
    "InsideInterpolatedString", // e.g. {name.uppercase()}
    "Number",

    // Comments
    "Comment_SingleExpanded", // # This is a comment
    "Comment_SingleCollapsed", // #* This is a comment
    "Comment_SingleIgnored", // #! This is a comment that should be ignored

    "Comment_MultilineExpanded", // #< This is a multiline comment >#
    "Comment_MultilineCollapsed", // #> This is a multiline comment <#
    "Comment_MultilineIgnored", // #[This is a multiline comment that should be ignored]

    // Misc
    "Identifier",

] as const;

export type ValuedTokenType = typeof valuedTokenTypes[number];

const unitTokenTypes = [
    // Grouping
    "BracketOpen",
    "BracketClose",
    "BraceOpen",
    "BraceClose",
    "ParenOpen",
    "ParenClose",

    // Punctuation
    "Dot",
    "Comma",
    "Colon",
    "Semicolon",
    "AtSymbol",

    // Misc punctuation
    "Pound",

    // Operators
    "Plus",           // +
    "Minus",          // -
    "Asterisk",       // *
    "FwdSlash",       // /
    "Percent",        // %
    "Caret",          // ^
    "Exclamation",    // !
    "Ampersand",      // &
    "Pipe",           // |
    "LeftChevron",    // <
    "RightChevron",   // >
    "Equals",         // =

    // Special
    "EOF"
] as const;

export type UnitTokenType = typeof unitTokenTypes[number];

export type TokenType = ValuedTokenType | UnitTokenType

type TokenInfo =
    | { type: ValuedTokenType; value: string }
    | { type: UnitTokenType };

export type ValuedToken = { type: ValuedTokenType; value: string };
export type UnitToken = { type: ValuedTokenType };

interface TokenPos {
    line: number;
    column: number;
}

export interface Token {
    token: TokenInfo;
    start: TokenPos;
    end: TokenPos;
}

export function isValuedTokenType(type: TokenType): type is ValuedTokenType {
    return valuedTokenTypes.includes(type as ValuedTokenType);
}

export function isUnitTokenType(type: TokenType): type is UnitTokenType {
    return unitTokenTypes.includes(type as UnitTokenType);
}