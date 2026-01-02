/**
 * @fileoverview Contains the main lexer class for the Katnip compiler.
 */

import { 
    isUnitTokenType,
    isValuedTokenType
} from "./Token.js";

import type { 
    Token,
    TokenType,

    ValuedTokenType,
    UnitTokenType,
} from "./Token.js";

import { LexerState } from "./LexerState.js";
import { ErrorReporter, KatnipError } from "../utils/ErrorReporter.js";
import { Logger, KatnipLog, KatnipLogType } from "../utils/Logger.js";

export class Lexer {
    private position = 0;
    private line = 1;
    private lineStart = 0;
    private col = 1;
    private colStart = 1;
    private currentState: LexerState = LexerState.Start;
    private buffer: string = "";
    private stringQuote: "'" | '"' | null = null;
    private commentType: string = "";
    private tokens: Token[] = [];

    /**
     * Creates a new Lexer instance.
     */
    constructor(
        private reporter: ErrorReporter,
        private logger: Logger = new Logger(),
    ) {}

    /**
     * Tokenizes the provided source code into an array of tokens.
     * 
     * @param src Source code to tokenize.
     * @returns The tokens extracted from the source code.
     */
    tokenize(src: string): Token[] {
        src = src.replaceAll(/\x04/g, "").replaceAll("\r", ""); // Remove any existing EOF characters
        src += "\x04"; // EOF Sentinel

        this.position = 0;
        this.line = 1;
        this.lineStart = 0;
        this.col = 1;
        this.colStart = 1;
        this.currentState = LexerState.Start;
        this.buffer = "";
        this.stringQuote = null;
        this.commentType = "";
        this.tokens = [];

        while (this.position < src.length) {
            const char = this.peek(src);
            if (char === null) {
                break; // End of input
            }

            this.processChar(char, src);
        }

        this.buffer = "\x04";
        this.emit("EOF"); // Emit EOF token at the end
        return this.tokens;
    }

    /**
     * Emits a token based on the current buffer and resets the buffer.
     * 
     * @param type The type of token to emit.
     */
    private emit(type: TokenType): void {
        this.buffer = this.buffer.trim();
        if (isValuedTokenType(type)) {
            this.tokens.push({
                token: { type, value: this.buffer },
                start: { line: this.lineStart, column: this.colStart },
                end: { line: this.line, column: this.col }
            });
        } else if (isUnitTokenType(type)) {
            this.tokens.push({
                token: { type },
                start: { line: this.lineStart, column: this.colStart },
                end: { line: this.line, column: this.col }
            });
        }
        this.buffer = ""; // Reset buffer after emitting
        this.currentState = LexerState.Start;
    }

    /**
     * Peeks at the next character in the source code without consuming it.
     * 
     * @param src The source code to peek into.
     * @param distance The number of characters to look ahead (default is 0).
     * @returns The character at the specified distance or null if out of bounds.
     */
    private peek(src: string, distance: number = 0): string | null {
        if (this.position < src.length) {
            return src[this.position + distance];
        }
        return null;
    }

    /**
     * Advances the lexer position by one character and updates line/column tracking.
     * 
     * @param src The source code to advance in.
     * @returns The character that was advanced or null if at the end of input.
     */
    private advance(src: string): string | null {
        const char = this.peek(src);
        if (char !== null) {
            this.position++;
            if (char === '\n') {
                this.line++;
                this.col = 1;
            } else {
                this.col++;
            }
        }
        return char;
    }

    /**
     * Processes a single character from the source code and updates the lexer state.
     * 
     * @param char The character to process.
     * @param src The source code being tokenized.
     */
    private processChar(char: string, src: string): void {
        // this.logger.log(new KatnipLog( KatnipLogType.Debug, `Lexer state: ${LexerState[this.currentState]}, char: '${char}'`, { line: this.line, column: this.col } ));

        if (this.currentState === LexerState.Start) {
            this.colStart = this.col; // Reset column start for new token
            this.lineStart = this.line; // Reset line start for new token

            // if (char === '\n' && this.peek(src, 1) !== '\n') { // Check for single newline
            //     this.emit("Newline");
            // }

            if (/\s/.test(char)) {
                // Whitespace
                this.advance(src);
            } else if (/[a-zA-Z_]/.test(char)) {
                // Identifier start
                this.currentState = LexerState.Identifier;
                this.buffer += this.advance(src);
            } else if (/[-0-9]/.test(char) || (/[.]/.test(char) && /[0-9]/.test(this.peek(src, 1)!))) {
                if (/[.0-9]/.test(this.peek(src, 1)!) || /[0-9]/.test(char)) {
                    // Number literal start
                    this.currentState = LexerState.Number;
                    this.buffer += this.advance(src);
                } else {
                    // Just a minus sign
                    this.currentState = LexerState.Operator;
                    this.buffer += this.advance(src);
                }
            } else if (char === '"' || char === "'") {
                // String literal start
                this.stringQuote = char;
                this.currentState = LexerState.String;
                this.buffer += this.advance(src);
            } else if (/[+\-*/%&|^!<>?=]/.test(char)) {
                // Operator start
                this.currentState = LexerState.Operator;
                this.buffer += this.advance(src);
            } else if (/[.,;:@(){}\[\]]/.test(char)) {
                // Punctuation
                this.currentState = LexerState.Punctuation;
                this.buffer += this.advance(src);
            } else if (char === '#') {
                // Comment start
                this.currentState = LexerState.Comment;
                this.advance(src);
            } else if (char === '\x04') {
                this.advance(src); // Consume EOF character
                this.emit("EOF");
            } else {
                this.reporter.add(
                    new KatnipError("Lexer", `Unexpected character '${char}'`, { line: this.line, column: this.col })
                );
            }
        } else {
            this.processState(char, src);
        }
    }

    /**
     * Processes the current state of the lexer based on the character and source code.
     * 
     * @param char The current character being processed.
     * @param src The source code being tokenized.
     */
    private processState(char: string, src: string): void {
        this.logger.log(new KatnipLog( KatnipLogType.Debug, `Lexer state: ${LexerState[this.currentState]}, char: '${char}', buffer: '${this.buffer}'`, { line: this.line, column: this.col } ));
        // State: Identifier
        if (this.currentState === LexerState.Identifier) {
            if (/[a-zA-Z0-9_]/.test(char)) {
                this.buffer += this.advance(src);
            } else {
                this.emit("Identifier");
                this.currentState = LexerState.Start;
            }
        }

        // State: String
        else if (this.currentState === LexerState.String) {
            if (char === this.stringQuote) {
                this.buffer += this.advance(src);
                this.emit("String");
            } else if (char === '\\') {
                // Handle escape sequences
                this.buffer += this.advance(src);
                this.currentState = LexerState.EscapedString;
            } else {
                this.buffer += this.advance(src);
            }
        }

        // State: Escaped String
        else if (this.currentState === LexerState.EscapedString) {
            if (char === null) {
                this.reporter.add(
                    new KatnipError("Lexer", `Unterminated string literal`, { line: this.line, column: this.col })
                );
            }

            if (char === "u") {
                // Handle Unicode escape sequences
                let unicodeBuffer = "";
                for (let i = 0; i < 4; i++) {
                    const nextChar = this.advance(src);
                    if (nextChar === null || !/[0-9a-fA-F]/.test(nextChar)) {
                        this.reporter.add(
                            new KatnipError("Lexer", `Invalid Unicode escape sequence`, { line: this.line, column: this.col })
                        );
                    }
                    unicodeBuffer += nextChar;
                }
                this.buffer += String.fromCharCode(parseInt(unicodeBuffer, 16));
            } else {
                const escapeSequenceMap: Record<string, string> = {
                    "n": "\n",
                    "t": "\t",
                    "r": "\r",
                };
                this.buffer += escapeSequenceMap[char] ?? char;
            }

            // Reset to String state after handling escape
            this.currentState = LexerState.String;
        }

        // State: Number
        else if (this.currentState === LexerState.Number) {
            if (/[0-9]/.test(char)) {
                this.buffer += this.advance(src);
            } else if (char === '.') {
                // Handle decimal point
                if (this.buffer.includes('.')) {
                    this.reporter.add(
                        new KatnipError("Lexer", `Invalid number format: Multiple decimal points`, { line: this.line, column: this.col })
                    );
                    this.emit("Number");
                    this.currentState = LexerState.Start;
                } else {
                    this.buffer += this.advance(src);
                    this.currentState = LexerState.Number; // Still in number state
                }
            } else if (/[eE]/.test(char)) {
                // Handle exponential notation
                if (this.buffer.includes('e') || this.buffer.includes("E")) {
                    this.reporter.add(
                        new KatnipError("Lexer", `Invalid number format: Multiple exponentional notation characters`, { line: this.line, column: this.col })
                    );
                    this.emit("Number");
                    this.currentState = LexerState.Start;
                } else {
                    this.buffer += this.advance(src);
                    this.currentState = LexerState.Number; // Still in number state
                }
            } else if (/[+\-]/.test(char)) {
                // Handle sign in scientific notation
                if (this.buffer.slice(-1) === 'e' || this.buffer.slice(-1) === 'E') {
                    this.buffer += this.advance(src);
                } else {
                    this.emit("Number");
                    this.currentState = LexerState.Start;
                }
            } else if (/[xbo]/.test(char)) {
                // Handle hexadecimal or binary prefixes
                if (this.buffer === "0") {
                    this.buffer += this.advance(src); // consume 'x', 'b', or 'o'
                    this.currentState = LexerState.Number; // stay in number state
                } else {
                    this.emit("Number");
                    this.currentState = LexerState.Start;
                }
            } else {
                this.emit("Number");
                this.currentState = LexerState.Start;
            }
        }

        // State: Operator
        else if (this.currentState === LexerState.Operator) {
            const operatorMap: Record<string, string> = {
                "+": "Plus",
                "-": "Minus",
                "*": "Asterisk",
                "/": "FwdSlash",
                "%": "Percent",
                "^": "Caret",
                "!": "Exclamation",
                "&": "Ampersand",
                "|": "Pipe",
                "<": "LeftChevron",
                ">": "RightChevron",
                "=": "Equals"
            };

            // Check for multi-character operators (omit < and > from the checks, as those appear in types)
            if (/[+\-*/%&|^!?=]/.test(char)) {
                this.buffer += this.advance(src);
            } else {
                this.emit(operatorMap[this.buffer] as UnitTokenType);
                this.currentState = LexerState.Start;
            }
        }

        // State: Punctuation
        else if (this.currentState === LexerState.Punctuation) {
            const punctuationMap: Record<string, string> = {
                ".": "Dot",
                ",": "Comma",
                ":": "Colon",
                ";": "Semicolon",
                "@": "AtSymbol",
                "(": "ParenOpen",
                ")": "ParenClose",
                "{": "BraceOpen",
                "}": "BraceClose",
                "[": "BracketOpen",
                "]": "BracketClose"
            };
            
            this.emit(punctuationMap[this.buffer] as UnitTokenType);
            this.currentState = LexerState.Start;
        }

        else if (this.currentState === LexerState.Comment) {
            this.logger.log(new KatnipLog( KatnipLogType.Debug, `In Comment state of type: '${this.commentType}', char: '${char}', buffer: '${this.buffer}'`, { line: this.line, column: this.col } ));
            const commentMap: Record<string, [ValuedTokenType, string]> = {
                "none": ["Comment_SingleExpanded", "\n"],
                "*": ["Comment_SingleCollapsed", "\n"],
                "!": ["Comment_SingleIgnored", "\n"],
                "<": ["Comment_MultilineExpanded", ">#"],
                ">": ["Comment_MultilineCollapsed", "<#"],
                "[": ["Comment_MultilineIgnored", "]#"]
            };

            if (this.commentType === "") {
                const nextChar = this.advance(src);
                if (nextChar && commentMap[nextChar]) {
                    this.commentType = nextChar;
                } else {
                    this.commentType = "none"; // Default to single-line comment
                }
            } else {
                const [tokenType, commentEnd] = commentMap[this.commentType];

                // Multichar end delimiter
                if (commentEnd.length === 2 && char + this.peek(src, 1) === commentEnd) {
                    this.advance(src); // 1st char of delimiter
                    this.advance(src); // 2nd char of delimiter
                    if (tokenType !== "Comment_MultilineIgnored") this.emit(tokenType);
                    this.currentState = LexerState.Start;
                    this.commentType = "";
                }
                // Single-char end delimiter
                else if (commentEnd.length === 1 && char === commentEnd) {
                    this.advance(src); // Move past delimiter
                    if (tokenType !== "Comment_SingleIgnored") this.emit(tokenType);
                    this.currentState = LexerState.Start;
                    this.commentType = "";
                }
                // No end yet -> keep buffering
                else {
                    this.buffer += this.advance(src) ?? "";
                }
            }
        }
    }
}