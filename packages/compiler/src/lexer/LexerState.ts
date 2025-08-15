/**
 * @fileoverview Contains the lexer state enum for the Katnip lexer.
 */

export enum LexerState {
    Start,

    Identifier,

    String,
    EscapedString,
    Number,

    Operator,
    Punctuation,

    Comment,
}