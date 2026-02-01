/**
 * @fileoverview Token definitions for the Katnip lexer.
 */

// Valued token types
export const ValuedTokenType = {
    // Literals
    String: "String",
    InterpolatedString: "InterpolatedString",
    InsideInterpolatedString: "InsideInterpolatedString",
    Number: "Number",

    // Comments
    Comment_SingleExpanded: "Comment_SingleExpanded",
    Comment_SingleCollapsed: "Comment_SingleCollapsed",
    Comment_SingleIgnored: "Comment_SingleIgnored",

    Comment_MultilineExpanded: "Comment_MultilineExpanded",
    Comment_MultilineCollapsed: "Comment_MultilineCollapsed",
    Comment_MultilineIgnored: "Comment_MultilineIgnored",

    // Misc
    Identifier: "Identifier",

    // Used for error handling, not a real token type
    ErrorToken: "ErrorToken",
} as const;

export type ValuedTokenType = typeof ValuedTokenType[keyof typeof ValuedTokenType];


// Unit token types
export const UnitTokenType = {
    // Grouping
    BracketOpen: "[",
    BracketClose: "]",
    BraceOpen: "{",
    BraceClose: "}",
    ParenOpen: "(",
    ParenClose: ")",

    // Punctuation
    Dot: ".",
    Comma: ",",
    Colon: ":",
    Semicolon: ";",
    AtSymbol: "@",

    // Misc punctuation
    Pound: "#",
    QuestionMark: "?",

    // Operators
    Plus: "+",
    Minus: "-",
    Asterisk: "*",
    FwdSlash: "/",
    Percent: "%",
    Caret: "^",
    Exclamation: "!",
    Ampersand: "&",
    Pipe: "|",
    LeftChevron: "<",
    RightChevron: ">",
    Equals: "=",

    // Double-character operators
    Power: "**",
    EqualsTo: "==",
    LessThanOrEqualsTo: "<=",
    GreaterThanOrEqualsTo: ">=",
    AND: "&&",
    OR: "||",
    NAND: "!&",
    NOR: "!|",
    XNOR: "!^",

    // Assignment operators
    PlusEquals: "+=",
    MinusEquals: "-=",
    AsteriskEquals: "*=",
    PowerEquals: "**=",
    FwdSlashEquals: "/=",
    PercentEquals: "%=",

    // Special
    FunctionReturn: "->",
    Newline: "\n",
    EOF: "<EOF>",
} as const;

export type UnitTokenType = typeof UnitTokenType[keyof typeof UnitTokenType];
export const unitTokenByLexeme = new Map<UnitTokenType, UnitTokenType>(
    Object.entries(UnitTokenType).map(([_, value]) => [value, value])
);
export const singleCharUnitTokens = new Set<UnitTokenType>(
    Object.values(UnitTokenType).filter(t => t.length === 1)
);


export class OperatorTrieNode {
    children: Map<string, OperatorTrieNode> = new Map();
    tokenType: UnitTokenType | null = null;
}

export class OperatorTrie {
    private root = new OperatorTrieNode();
    constructor(operators: readonly UnitTokenType[]) {
        for (const op of operators) {
            this.insert(op);
        }
    }

    private insert(op: UnitTokenType): void {
        let node = this.root;
        for (const char of op) {
            let next = node.children.get(char);
            if (!next) {
                next = new OperatorTrieNode();
                node.children.set(char, next);
            }
            node = next;
        }
        node.tokenType = op;
    }

    start(): OperatorTrieNode { return this.root; }
    step(node: OperatorTrieNode, char: string): OperatorTrieNode | null { return node.children.get(char) ?? null; }
}

export const operatorTrie = new OperatorTrie(Object.values(UnitTokenType));


// Token structure
export type TokenType = ValuedTokenType | UnitTokenType
export type TokenInfoFor<T extends TokenType> =
    T extends ValuedTokenType ? { type: T; value: string } :
    T extends UnitTokenType   ? { type: T } :
    never;

type TokenInfo = ValuedToken | UnitToken;

export type ValuedToken = { type: ValuedTokenType; value: string };
export type UnitToken = { type: UnitTokenType };


// Token position structure
export interface TokenPos {
    line: number;
    column: number;
}

export interface Token {
    token: TokenInfo;
    start: TokenPos;
    end: TokenPos;
}


// Type guards
const valuedTokenTypeSet = new Set<string>(
    Object.values(ValuedTokenType)
);

const unitTokenTypeSet = new Set<string>(
    Object.values(UnitTokenType)
);

export function isValuedTokenType(type: string): type is ValuedTokenType {
    return valuedTokenTypeSet.has(type);
}

export function isUnitTokenType(type: string): type is UnitTokenType {
    return unitTokenTypeSet.has(type);
}