import { 
    Token,
    TokenType,

    isValuedTokenType,
    ValuedTokenType,
    isUnitTokenType,
    UnitTokenType,
} from "./Token";

import { LexerState } from "./LexerState";
import { ErrorReporter, KatnipError } from "../utils/ErrorReporter";
import { Logger, KatnipLog, KatnipLogType } from "../utils/Logger";

export class Lexer {
    /**
     * Creates a new Lexer instance.
     */
    constructor(
        private reporter: ErrorReporter,
        private logger: Logger = new Logger()
    ) {}

    /**
     * Tokenizes the provided source code into an array of tokens.
     * 
     * @param src Source code to tokenize.
     * @returns The tokens extracted from the source code.
     */
    tokenize(src: string): Token[] {
        // Add a sentinel character to the end
        src = src.replace(/\x04/g, ""); // Remove any existing EOF characters
        src += "\x04"; // EOF Sentinel

        let position = 0;
        let line = 1;
        let lineStart = 0; // Track start of current token
        let col = 1;
        let colStart = 1; // Track start column of current token
        const tokens: Token[] = [];
        let currentState: LexerState = LexerState.Start;
        let buffer: string = "";

        // Flags
        let stringQuote: "'" | '"' | null = null; // tracks current quote type
        let commentType: string = ""; // tracks comment type if in comment state

        const emit = (type: TokenType): void => {
            if (buffer.length > 0) {
                buffer = buffer.trim(); // Trim whitespace from buffer
                if (buffer === "") return; // Skip empty buffers
                if (isValuedTokenType(type)) {
                    tokens.push({
                        token: { type, value: buffer },
                        start: { line: lineStart, column: colStart },
                        end: { line, column: col }
                    });
                } else if (isUnitTokenType(type)) {
                    tokens.push({
                        token: { type },
                        start: { line: lineStart, column: colStart },
                        end: { line, column: col }
                    });
                }
                buffer = ""; // Reset buffer after emitting
                currentState = LexerState.Start;
            }
        };

        const peek = (distance: number = 0): string | null => {
            if (position < src.length) {
                return src[position + distance];
            }
            return null;
        }

        const advance = (): string | null => {
            const char = peek();
            if (char !== null) {
                position++;
                if (char === '\n') {
                    line++;
                    col = 1;
                } else {
                    col++;
                }
            }
            return char;
        }

        while (position < src.length) {
            const char = peek();
            if (char === null) {
                break; // End of input
            }

            // this.logger.log(new KatnipLog(KatnipLogType.Debug, `Lexer state: ${LexerState[currentState]}, char: '${char}'`, { line, column: col }));

            // State: Start
            if (currentState === LexerState.Start) {
                colStart = col; // Reset column start for new token
                lineStart = line; // Reset line start for new token

                if (/\s/.test(char)) {
                    // Whitespace
                    advance();
                } else if (/[a-zA-Z_]/.test(char)) {
                    // Identifier start
                    currentState = LexerState.Identifier;
                    buffer += advance();
                } else if (/[\-0-9]/.test(char)) {
                    // Number literal start
                    currentState = LexerState.Number;
                    buffer += advance();
                } else if (char === '"' || char === "'") {
                    // String literal start
                    stringQuote = char;
                    currentState = LexerState.String;
                    buffer += advance();
                } else if (/[+\-*/%&|^!<>?=]/.test(char)) {
                    // Operator start
                    currentState = LexerState.Operator;
                    buffer += advance();
                } else if (/[.,;:@(){}\[\]]/.test(char)) {
                    // Punctuation
                    currentState = LexerState.Punctuation;
                    buffer += advance();
                } else if (char === '#') {
                    // Comment start
                    currentState = LexerState.Comment;
                    advance();
                } else if (char === '\x04') {
                    advance(); // Consume EOF character
                } else {
                    this.reporter.add(
                        new KatnipError("Lexer", `Unexpected character '${char}'`, { line: line, column: col })
                    );
                }
            }
            
            // State: Identifier
            else if (currentState === LexerState.Identifier) {
                if (/[a-zA-Z0-9_]/.test(char)) {
                    buffer += advance();
                } else {
                    emit("Identifier");
                    currentState = LexerState.Start;
                }
            }

            // State: String
            else if (currentState === LexerState.String) {
                if (char === stringQuote) {
                    buffer += advance();
                    emit("String");
                } else if (char === '\\') {
                    // Handle escape sequences
                    buffer += advance();
                    currentState = LexerState.EscapedString;
                } else {
                    buffer += advance();
                }
            }

            // State: Escaped String
            else if (currentState === LexerState.EscapedString) {
                if (char === null) {
                    this.reporter.add(
                        new KatnipError("Lexer", `Unterminated string literal`, { line: line, column: col })
                    );
                }

                if (char === "u") {
                    // Handle Unicode escape sequences
                    let unicodeBuffer = "";
                    for (let i = 0; i < 4; i++) {
                        const nextChar = advance();
                        if (nextChar === null || !/[0-9a-fA-F]/.test(nextChar)) {
                            this.reporter.add(
                                new KatnipError("Lexer", `Invalid Unicode escape sequence`, { line: line, column: col })
                            );
                        }
                        unicodeBuffer += nextChar;
                    }
                    buffer += String.fromCharCode(parseInt(unicodeBuffer, 16));
                } else {
                    const escapeSequenceMap: Record<string, string> = {
                        "n": "\n",
                        "t": "\t",
                        "r": "\r",
                    };
                    buffer += escapeSequenceMap[char] ?? char;
                }

                // Reset to String state after handling escape
                currentState = LexerState.String;
            }

            // State: Number
            else if (currentState === LexerState.Number) {
                if (/[0-9]/.test(char)) {
                    buffer += advance();
                } else if (char === '.') {
                    // Handle decimal point
                    if (buffer.includes('.')) {
                        this.reporter.add(
                            new KatnipError("Lexer", `Invalid number format: Multiple decimal points`, { line: line, column: col })
                        );
                        emit("Number");
                        currentState = LexerState.Start;
                    } else {
                        buffer += advance();
                        currentState = LexerState.Number; // Still in number state
                    }
                } else if (/[eE]/.test(char)) {
                    // Handle decimal point
                    if (buffer.includes('e') || buffer.includes("E")) {
                        this.reporter.add(
                            new KatnipError("Lexer", `Invalid number format: Multiple exponentional notation characters`, { line: line, column: col })
                        );
                        emit("Number");
                        currentState = LexerState.Start;
                    } else {
                        buffer += advance();
                        currentState = LexerState.Number; // Still in number state
                    }
                } else if (/[+\-]/.test(char)) {
                    // Handle sign in scientific notation
                    if (buffer.slice(-1) === 'e' || buffer.slice(-1) === 'E') {
                        buffer += advance();
                    } else {
                        emit("Number");
                        currentState = LexerState.Start;
                    }
                } else if (/[xbo]/.test(char)) {
                    // Handle hexadecimal or binary prefixes
                    if (buffer === "0") {
                        buffer += advance(); // consume 'x', 'b', or 'o'
                        currentState = LexerState.Number; // stay in number state
                    } else {
                        emit("Number");
                        currentState = LexerState.Start;
                    }
                } else {
                    emit("Number");
                    currentState = LexerState.Start;
                }
            }

            // State: Operator
            else if (currentState === LexerState.Operator) {
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

                if (/[+\-*/%&|^!<>?=]/.test(char)) {
                    buffer += advance();
                } else {
                    emit(operatorMap[buffer] as UnitTokenType);
                    currentState = LexerState.Start;
                }
            }

            // State: Punctuation
            else if (currentState === LexerState.Punctuation) {
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

                if (/[.,;:(){}\[\]]/.test(char)) {
                    buffer += advance();
                } else {
                    emit(punctuationMap[buffer] as UnitTokenType);
                }
            }

            else if (currentState === LexerState.Comment) {
                const commentMap: Record<string, [ValuedTokenType, string]> = {
                    "none": ["Comment_SingleExpanded", "\n"],
                    "*": ["Comment_SingleCollapsed", "\n"],
                    "!": ["Comment_SingleIgnored", "\n"],
                    "<": ["Comment_MultilineExpanded", ">#"],
                    ">": ["Comment_MultilineCollapsed", "<#"],
                    "[": ["Comment_MultilineIgnored", "]#"]
                };

                if (commentType === "") {
                    const nextChar = advance();
                    if (nextChar && commentMap[nextChar]) {
                        commentType = nextChar;
                    } else {
                        commentType = "none"; // Default to single-line comment
                    }
                } else {
                    const [tokenType, commentEnd] = commentMap[commentType];

                    // Multichar end delimiter
                    if (commentEnd.length === 2 && char + peek(1) === commentEnd) {
                        advance();
                        advance();
                        emit(tokenType);
                        currentState = LexerState.Start;
                        commentType = "";
                    }
                    // Single-char end delimiter
                    else if (commentEnd.length === 1 && char === commentEnd) {
                        advance();
                        emit(tokenType);
                        currentState = LexerState.Start;
                        commentType = "";
                    }
                    // No end yet -> keep buffering
                    else {
                        buffer += advance() ?? "";
                    }
                }
            }
        }

        return tokens;
    }
}