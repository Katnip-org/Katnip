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