/**
 * @fileoverview Contains the main lexer class for the Katnip compiler.
 */

import { 
    isUnitTokenType,
    isValuedTokenType,
    unitTokenByLexeme,
    operatorTrie,
    singleCharUnitTokens
} from "./Token.js";

import type { 
    Token,
    TokenType,

    ValuedTokenType,
    UnitTokenType,
    OperatorTrieNode,
} from "./Token.js";

import { LexerState } from "./LexerState.js";
import { ErrorReporter, KatnipError } from "../utils/ErrorReporter.js";
import { Logger, KatnipLog, KatnipLogType } from "../utils/Logger.js";

export class Lexer {
    // Lexer traversal position
    private src: string = "";
    private position = 0;
    private line = 1;
    private lineStart = 0;
    private col = 1;
    private colStart = 1;
    
    // Lexer states
    private currentState: LexerState = LexerState.Start;

    private buffer: string = "";
    private stringQuote: "'" | '"' | null = null;
    private commentType: string = "";

    private operatorNode: OperatorTrieNode | null = null;
    private lastValidOperatorNode: { node: OperatorTrieNode, len: number } | null = null;

    // Emitted tokens
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
        this.src = src.replaceAll(/\x04/g, "").replaceAll("\r", ""); // Remove any existing EOF characters
        this.src += "\x04"; // EOF Sentinel

        this.position = 0;
        this.line = 1;
        this.lineStart = 0;
        this.col = 1;
        this.colStart = 1;
        
        this.currentState = LexerState.Start;

        this.buffer = "";
        this.stringQuote = null;
        this.commentType = "";
        this.operatorNode = null;

        this.operatorNode = null;

        this.tokens = [];

        while (this.position < this.src.length) {
            const char = this.peek();
            if (char === null) {
                break; // End of input
            }

            this.processChar(char);
        }

        this.buffer = "\x04";
        this.emit("<EOF>"); // Emit EOF token at the end
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
     * @param distance The number of characters to look ahead (default is 0).
     * @returns The character at the specified distance or null if out of bounds.
     */
    private peek(distance: number = 0): string | null {
        if (this.position < this.src.length) {
            return this.src[this.position + distance];
        }
        return null;
    }

    /**
     * Advances the lexer position by one character and updates line/column tracking.
     * 
     * @returns The character that was advanced or null if at the end of input.
     */
    private advance(amount: number = 1): string | null {
        let char = this.peek();
        for (let i = 0; i < amount; i++) {
            char = this.peek();
            if (char !== null) {
                this.position++;
                if (char === '\n') {
                    this.line++;
                    this.col = 1;
                } else {
                    this.col++;
                }
            }
        }
        return char;
    }

    /**
     * Processes a single character from the source code and updates the lexer state.
     * 
     * @param char The character to process.
     */
    private processChar(char: string): void {
        this.logger.log(new KatnipLog( KatnipLogType.Debug, `Lexer state: ${LexerState[this.currentState]}, char: '${char}'`, { line: this.line, column: this.col } ));

        if (this.currentState === LexerState.Start) {
            this.colStart = this.col; // Reset column start for new token
            this.lineStart = this.line; // Reset line start for new token

            if (/\s/.test(char)) {
                // Whitespace
                this.advance();
            } else if (/[a-zA-Z_]/.test(char)) {
                // Identifier start
                this.currentState = LexerState.Identifier;
                this.buffer += this.advance();
            } else if (/[-0-9]/.test(char) || (/[.]/.test(char) && /[0-9]/.test(this.peek(1)!))) {
                if (/[.0-9]/.test(this.peek(1)!) || /[0-9]/.test(char)) {
                    // Number literal start
                    this.currentState = LexerState.Number;
                    this.buffer += this.advance();
                } else {
                    // Just a minus sign
                    this.currentState = LexerState.Operator;
                }
            } else if (char === '"' || char === "'") {
                // String literal start
                this.stringQuote = char;
                this.currentState = LexerState.String;
                this.buffer += this.advance();
            } else if (char === '#') {
                // Comment start
                this.currentState = LexerState.Comment;
                this.advance();
            } else if (singleCharUnitTokens.has(char as UnitTokenType)) {
                this.currentState = LexerState.Operator;
                this.operatorNode = operatorTrie.start();
            } else if (char === '\x04') {
                this.advance(); // Consume EOF character
                this.emit("<EOF>");
            } else {
                this.reporter.add(
                    new KatnipError("Lexer", `Unexpected character '${char}'`, { line: this.line, column: this.col })
                );
            }
        } else {
            this.processState(char);
        }
    }

    /**
     * Processes the current state of the lexer based on the character and source code.
     * 
     * @param char The current character being processed.
     */
    private processState(char: string): void {
        this.logger.log(new KatnipLog( KatnipLogType.Debug, `Lexer state: ${LexerState[this.currentState]}, char: '${char}', buffer: '${this.buffer}'`, { line: this.line, column: this.col } ));
        // State: Identifier
        switch (this.currentState) {
            case LexerState.Identifier:
                if (/[a-zA-Z0-9_]/.test(char)) {
                    this.buffer += this.advance();
                } else {
                    this.emit("Identifier");
                    this.currentState = LexerState.Start;
                }
                break;

            case LexerState.String:
                if (char === this.stringQuote) {
                    this.buffer += this.advance();
                    this.emit("String");
                } else if (char === '\\') {
                    // Handle escape sequences
                    this.buffer += this.advance();
                    this.currentState = LexerState.EscapedString;
                } else {
                    this.buffer += this.advance();
                }
                break;

            case LexerState.EscapedString:
                const escaped = this.advance();

                if (escaped === null) {
                    this.reporter.add(
                        new KatnipError("Lexer", `Unterminated string literal`, { line: this.line, column: this.col })
                    );
                    break;
                }

                if (escaped === "u") {
                    // Handle Unicode escape sequences
                    let unicodeBuffer = "";
                    for (let i = 0; i < 4; i++) {
                        const nextChar = this.advance();
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
                    this.buffer += escapeSequenceMap[escaped] ?? escaped;
                }

                // Reset to String state after handling escape
                this.currentState = LexerState.String;
                break;

            case LexerState.Number:
                if (/[0-9]/.test(char)) {
                    this.buffer += this.advance();
                } else if (char === '.') {
                    // Handle decimal point
                    if (this.buffer.includes('.')) {
                        this.reporter.add(
                            new KatnipError("Lexer", `Invalid number format: Multiple decimal points`, { line: this.line, column: this.col })
                        );
                        this.emit("Number");
                        this.currentState = LexerState.Start;
                    } else {
                        this.buffer += this.advance();
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
                        this.buffer += this.advance();
                        this.currentState = LexerState.Number; // Still in number state
                    }
                } else if (/[+\-]/.test(char)) {
                    // Handle sign in scientific notation
                    if (this.buffer.slice(-1) === 'e' || this.buffer.slice(-1) === 'E') {
                        this.buffer += this.advance();
                    } else {
                        this.emit("Number");
                        this.currentState = LexerState.Start;
                    }
                } else if (/[xbo]/.test(char)) {
                    // Handle hexadecimal or binary prefixes
                    if (this.buffer === "0") {
                        this.buffer += this.advance(); // consume 'x', 'b', or 'o'
                        this.currentState = LexerState.Number; // stay in number state
                    } else {
                        this.emit("Number");
                        this.currentState = LexerState.Start;
                    }
                } else {
                    this.emit("Number");
                    this.currentState = LexerState.Start;
                }
                break;

            case LexerState.Operator:
                // Initialize trie if starting over
                if (this.operatorNode === null) {
                    this.operatorNode = operatorTrie.start();
                    this.lastValidOperatorNode = null;
                    this.lineStart = this.lineStart ?? this.line;
                    this.colStart = this.colStart ?? this.col;
                }

                const stepNode = operatorTrie.step(this.operatorNode, char);

                if (stepNode) {
                    this.buffer += this.advance();
                    this.operatorNode = stepNode;

                    if (stepNode.tokenType) {
                        this.lastValidOperatorNode = { node: stepNode, len: this.buffer.length };
                    }

                    break;
                }

                if (this.lastValidOperatorNode) {
                    const opNode = this.lastValidOperatorNode.node;

                    if (opNode.tokenType) {
                        this.emit(opNode.tokenType);
                    }

                    const rewind = this.buffer.length - this.lastValidOperatorNode.len;
                    for (let i = 0; i < rewind; i++) {
                        this.position--;
                        this.col--;
                    }
                } else {
                    this.reporter.add(
                        new KatnipError(
                            "Lexer",
                            `Invalid operator '${this.buffer + char}'`,
                            { line: this.line, column: this.col }
                        )
                    );
                    this.advance();
                }

                // Reset
                this.operatorNode = null;
                this.lastValidOperatorNode = null;
                this.buffer = "";
                this.currentState = LexerState.Start;
                break;

            case LexerState.Comment:
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
                    const nextChar = this.advance();
                    if (nextChar && commentMap[nextChar]) {
                        this.commentType = nextChar;
                    } else {
                        this.commentType = "none"; // Default to single-line comment
                    }
                } else {
                    const [tokenType, commentEnd] = commentMap[this.commentType];

                    // Multichar end delimiter
                    if (commentEnd.length === 2 && char + this.peek(1) === commentEnd) {
                        this.advance(); // 1st char of delimiter
                        this.advance(); // 2nd char of delimiter
                        if (tokenType !== "Comment_MultilineIgnored") this.emit(tokenType);
                        this.currentState = LexerState.Start;
                        this.commentType = "";
                    }
                    // Single-char end delimiter
                    else if (commentEnd.length === 1 && char === commentEnd) {
                        this.advance(); // Move past delimiter
                        if (tokenType !== "Comment_SingleIgnored") this.emit(tokenType);
                        this.currentState = LexerState.Start;
                        this.commentType = "";
                    }
                    // No end yet -> keep buffering
                    else {
                        this.buffer += this.advance() ?? "";
                    }
                }
                break;
        }
    }
}