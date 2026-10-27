/**
 * @fileoverview Contains the main lexer class for the Katnip compiler.
 */

import { 
    isUnitTokenType,
    isValuedTokenType,
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
    private isInterpolatedString: boolean = false;
    private inInterpolatedExpression: boolean = false;
    private interpolatedBraceDepth: number = 0;
    private stringFrames: { quote: "'" | '"' | null, isInterp: boolean, inExpr: boolean, depth: number }[] = [];
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
        this.logger.print(new KatnipLog(KatnipLogType.Info, `--- Lexing started with ${src.length} characters ---`));
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
        this.isInterpolatedString = false;
        this.inInterpolatedExpression = false;
        this.interpolatedBraceDepth = 0;
        this.stringFrames = [];
        this.commentType = "";
        this.operatorNode = null;

        this.tokens = [];

        while (this.position < this.src.length) {
            const char = this.peek();
            if (char === null) {
                break;
            }

            // Forward-progress guard
            const posBefore = this.position;
            const stateBefore: LexerState = this.currentState;

            this.processChar(char);

            if (this.position === posBefore && this.currentState === stateBefore) {
                this.reporter.add(
                    new KatnipError(
                        "Lexer",
                        `Internal lexer error (this is a Katnip bug): no forward progress in state ` +
                        `${LexerState[this.currentState]} on ${JSON.stringify(char)}`,
                        { line: this.line, column: this.col },
                    )
                );
                break; // the guard exists to stop an infinite loop, so stop
            }
        }
        
        const endState = this.currentState as LexerState;
        if (
            endState === LexerState.String ||
            endState === LexerState.EscapedString ||
            endState === LexerState.InterpolatedExpression
        ) {
            this.reporter.add(
                new KatnipError("Lexer", `Unterminated string literal`, { line: this.lineStart, column: this.colStart })
            );
        }

        if (this.tokens.at(-1)?.token.type !== "<EOF>") {
            this.buffer = "";
            this.lineStart = this.line;
            this.colStart = this.col;
            this.emit("<EOF>");
        }

        return this.tokens;
    }

    /**
     * Emits a token based on the current buffer and resets the buffer.
     * 
     * @param type The type of token to emit.
     */
    private emit(type: TokenType): void {
        if (isValuedTokenType(type)) {
            if (type !== "String" && type !== "InterpolatedString" && type !== "InterpolatedStringEnd") {
                this.buffer = this.buffer.trim();
            }
            if (type === "Number" && Number.isNaN(Number(this.buffer))) {
                this.reporter.add(
                    new KatnipError("Lexer", `Invalid number format '${this.buffer}'`, { line: this.lineStart, column: this.colStart })
                );
            }
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
        this.buffer = "";
        this.currentState = this.inInterpolatedExpression ? LexerState.InterpolatedExpression : LexerState.Start;
    }

    /**
     * Peeks at the next character in the source code without consuming it.
     *
     * Characters are code points, not UTF-16 code units, so an emoji is one character.
     *
     * @param distance The number of characters to look ahead (default is 0).
     * @returns The character at the specified distance or null if out of bounds.
     */
    private peek(distance: number = 0): string | null {
        let pos = this.position;
        for (let i = 0; i < distance; i++) {
            const skipped = this.src.codePointAt(pos);
            if (skipped === undefined) return null;
            pos += String.fromCodePoint(skipped).length;
        }

        const code = this.src.codePointAt(pos);
        return code === undefined ? null : String.fromCodePoint(code);
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
                this.position += char.length; // 2 for astral characters
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
        if (this.logger.enabled) this.logger.log(new KatnipLog( KatnipLogType.Debug, `Lexer state: ${LexerState[this.currentState]}, char: '${char}'`, { line: this.line, column: this.col } ));

        if (this.currentState === LexerState.Start) {
            this.processStartLike(char);
        } else {
            this.processState(char);
        }
    }

    private processStartLike(char: string): void {
        this.colStart = this.col;
        this.lineStart = this.line;

        if (/\s/.test(char)) {
            this.advance();
        } else if (/[a-zA-Z_]/.test(char)) {
            this.currentState = LexerState.Identifier;
            this.buffer += this.advance();
        } else if (/[-0-9]/.test(char) || (/[.]/.test(char) && /[0-9]/.test(this.peek(1)!))) {
            // After an operand a minus is subtraction (x-1), not a negative literal
            if (/[.0-9]/.test(char) || (/[.0-9]/.test(this.peek(1)!) && !this.previousTokenEndsOperand())) {
                this.currentState = LexerState.Number;
                this.buffer += this.advance();
            } else {
                // Just a minus sign
                this.currentState = LexerState.Operator;
            }
        } else if (char === '"' || char === "'") {
            this.stringQuote = char;
            this.isInterpolatedString = false;
            this.currentState = LexerState.String;
            this.advance();
        } else if (char === '#') {
            this.currentState = LexerState.Comment;
            this.advance();
            const marker = this.peek();
            if (marker !== null && "*!<>[".includes(marker)) {
                this.commentType = marker;
                this.advance();
            } else {
                this.commentType = "none";
            }
        } else if (singleCharUnitTokens.has(char as UnitTokenType)) {
            this.currentState = LexerState.Operator;
            this.operatorNode = operatorTrie.start();
        } else if (char === '\x04') {
            this.advance();
            this.emit("<EOF>");
        } else {
            this.reporter.add(
                new KatnipError("Lexer", `Unexpected character '${char}'`, { line: this.line, column: this.col })
            );
            this.advance();
        }
    }

    private previousTokenEndsOperand(): boolean {
        const type = this.tokens.at(-1)?.token.type;
        return type === "Identifier" || type === "Number" || type === "String" || type === ")" || type === "]";
    }

    /**
     * Processes the current state of the lexer based on the character and source code.
     * 
     * @param char The current character being processed.
     */
    private processState(char: string): void {
        if (this.logger.enabled) this.logger.log(new KatnipLog( KatnipLogType.Debug, `Lexer state: ${LexerState[this.currentState]}, char: '${char}', buffer: '${this.buffer}'`, { line: this.line, column: this.col } ));
        switch (this.currentState) {
            case LexerState.Identifier:
                if (this.buffer === "f" && (char === '"' || char === "'")) {
                    this.stringQuote = char;
                    this.isInterpolatedString = true;
                    this.buffer = "";
                    this.currentState = LexerState.String;
                    this.advance();
                } else if (/[a-zA-Z0-9_]/.test(char)) {
                    this.buffer += this.advance();
                } else {
                    this.emit("Identifier");
                }
                break;

            case LexerState.String:
                if (this.isInterpolatedString && char === "{") {
                    this.emit("InterpolatedString");
                    this.buffer = "";
                    this.stringFrames.push({
                        quote: this.stringQuote,
                        isInterp: this.isInterpolatedString,
                        inExpr: this.inInterpolatedExpression,
                        depth: this.interpolatedBraceDepth,
                    });
                    this.advance();
                    this.inInterpolatedExpression = true;
                    this.interpolatedBraceDepth = 0;
                    this.currentState = LexerState.InterpolatedExpression;
                } else if (char === this.stringQuote) {
                    this.advance();
                    this.emit(this.isInterpolatedString ? "InterpolatedString" : "String");
                    this.isInterpolatedString = false;
                } else if (char === '\\') {
                    this.advance();
                    this.currentState = LexerState.EscapedString;
                } else {
                    this.buffer += this.advance();
                }
                break;

            case LexerState.InterpolatedExpression:
                if (char === "}") {
                    if (this.interpolatedBraceDepth === 0) {
                        this.lineStart = this.line;
                        this.colStart = this.col;
                        this.advance();
                        
                        const frame = this.stringFrames.pop();
                        this.stringQuote = frame?.quote ?? this.stringQuote;
                        this.isInterpolatedString = frame?.isInterp ?? true;
                        this.inInterpolatedExpression = frame?.inExpr ?? false;
                        this.interpolatedBraceDepth = frame?.depth ?? 0;

                        this.emit("InterpolatedStringEnd");
                        this.currentState = LexerState.String;
                        this.colStart = this.col;
                        this.lineStart = this.line;
                        break;
                    }
                    this.interpolatedBraceDepth--;
                } else if (char === "{") {
                    this.interpolatedBraceDepth++;
                }

                this.processStartLike(char);
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
                    let unicodeBuffer = "";
                    for (let i = 0; i < 4; i++) {
                        const nextChar = this.peek();
                        if (nextChar === null || !/[0-9a-fA-F]/.test(nextChar)) {
                            this.reporter.add(
                                new KatnipError("Lexer", `Invalid Unicode escape sequence`, { line: this.line, column: this.col })
                            );
                            break;
                        }
                        unicodeBuffer += this.advance();
                    }
                    if (unicodeBuffer.length === 4) {
                        this.buffer += String.fromCharCode(parseInt(unicodeBuffer, 16));
                    }
                } else {
                    const escapeSequenceMap: Record<string, string> = {
                        "n": "\n",
                        "t": "\t",
                        "r": "\r",
                    };
                    this.buffer += escapeSequenceMap[escaped] ?? escaped;
                }

                this.currentState = LexerState.String;
                break;

            case LexerState.Number:
                if (/[0-9]/.test(char) || (/[a-fA-F]/.test(char) && this.buffer.startsWith("0x"))) {
                    this.buffer += this.advance();
                } else if (char === '.') {
                    if (this.buffer.includes('.')) {
                        this.reporter.add(
                            new KatnipError("Lexer", `Invalid number format: Multiple decimal points`, { line: this.line, column: this.col })
                        );
                        this.emit("Number");
                    } else {
                        this.buffer += this.advance();
                    }
                } else if (/[eE]/.test(char)) {
                    if (this.buffer.includes('e') || this.buffer.includes("E")) {
                        this.reporter.add(
                            new KatnipError("Lexer", `Invalid number format: Multiple exponentional notation characters`, { line: this.line, column: this.col })
                        );
                        this.emit("Number");
                    } else {
                        this.buffer += this.advance();
                    }
                } else if (/[+\-]/.test(char)) {
                    if ((this.buffer.slice(-1) === 'e' || this.buffer.slice(-1) === 'E') && !this.buffer.startsWith("0x")) {
                        this.buffer += this.advance();
                    } else {
                        this.emit("Number");
                    }
                } else if (/[xbo]/.test(char)) {
                    if (this.buffer === "0") {
                        this.buffer += this.advance();
                    } else {
                        this.emit("Number");
                    }
                } else {
                    this.emit("Number");
                }
                break;

            case LexerState.Operator:
                if (this.operatorNode === null) {
                    this.operatorNode = operatorTrie.start();
                    this.lastValidOperatorNode = null;
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

                    // Rewind before emit() so the end position is right and the
                    // over-consumed chars get re-lexed (emit() clears the buffer).
                    // Only happens when a trie prefix is not itself an operator.
                    const rewind = this.buffer.length - this.lastValidOperatorNode.len;
                    for (let i = 0; i < rewind; i++) {
                        this.position--;
                        this.col--;
                    }

                    if (opNode.tokenType) {
                        this.emit(opNode.tokenType);
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

                this.operatorNode = null;
                this.lastValidOperatorNode = null;
                this.buffer = "";
                this.currentState = this.inInterpolatedExpression ? LexerState.InterpolatedExpression : LexerState.Start;
                break;

            case LexerState.Comment:
                if (this.logger.enabled) this.logger.log(new KatnipLog( KatnipLogType.Debug, `In Comment state of type: '${this.commentType}', char: '${char}', buffer: '${this.buffer}'`, { line: this.line, column: this.col } ));
                const commentMap: Record<string, [ValuedTokenType, string]> = {
                    "none": ["Comment_SingleExpanded", "\n"],
                    "*": ["Comment_SingleCollapsed", "\n"],
                    "!": ["Comment_SingleIgnored", "\n"],
                    "<": ["Comment_MultilineExpanded", ">#"],
                    ">": ["Comment_MultilineCollapsed", "<#"],
                    "[": ["Comment_MultilineIgnored", "]#"]
                };

                const [tokenType, commentEnd] = commentMap[this.commentType];

                if (commentEnd.length === 2 && char + this.peek(1) === commentEnd) {
                    this.advance(2);
                    if (tokenType !== "Comment_MultilineIgnored") this.emit(tokenType);
                    this.buffer = ""; // ignored comments skip emit(), so clear here
                    this.currentState = this.inInterpolatedExpression ? LexerState.InterpolatedExpression : LexerState.Start;
                    this.commentType = "";
                }
                else if (commentEnd.length === 1 && (char === commentEnd || char === '')) {
                    // Leave the EOF sentinel for the Start state
                    if (char !== '') this.advance();
                    if (tokenType !== "Comment_SingleIgnored") this.emit(tokenType);
                    this.buffer = ""; // ignored comments skip emit(), so clear here
                    this.currentState = this.inInterpolatedExpression ? LexerState.InterpolatedExpression : LexerState.Start;
                    this.commentType = "";
                }
                else if (char === '') {
                    this.reporter.add(
                        new KatnipError("Lexer", `Unterminated multiline comment`, { line: this.lineStart, column: this.colStart })
                    );
                    this.buffer = "";
                    this.currentState = this.inInterpolatedExpression ? LexerState.InterpolatedExpression : LexerState.Start;
                    this.commentType = "";
                }
                else {
                    this.buffer += this.advance() ?? "";
                }
                break;

            default:
                this.reporter.add(
                    new KatnipError("Lexer", `Unexpected character '${char}'`, { line: this.line, column: this.col })
                );
                this.advance();
                this.currentState = this.inInterpolatedExpression ? LexerState.InterpolatedExpression : LexerState.Start;
                break;
        }
    }
}
