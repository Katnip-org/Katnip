/**
 * @fileoverview Contains the main parser class for the Katnip compiler.
 */

import { isValuedTokenType } from "../lexer/Token.js";
import type { Token, TokenInfoFor, TokenPos, TokenType, ValuedToken, ValuedTokenType } from "../lexer/Token.js";
import { ErrorReporter, KatnipError } from "../utils/ErrorReporter.js";
import { Logger } from "../utils/Logger.js";
import { type AST, type DecoratorNode, type NodeBase, type ParameterNode, type ProcedureDeclarationNode, type SingleTypeNode, type TypeNode, type UnionTypeNode, type ExpressionNode, type DictEntryNode, type StatementNode, type EnumDeclarationNode, type VariableDeclarationNode, VariableDeclarationType } from "./AST-nodes.js";
import { bindingPowerTable, getBindingPower } from "./BindingPowerTable.js";

export class Parser {
    private tokens: Token[] = [];
    private position = 0;

    constructor(
        private reporter: ErrorReporter,
        private logger: Logger = new Logger(),
    ) {}

    /**
     * Parses a list of tokens into an Abstract Syntax Tree (AST).
     * @param tokens - The list of tokens to parse.
     * @returns The resulting AST or void if parsing fails.
     */
    parse(tokens: Token[]): AST | void {
        this.tokens = tokens;
        this.position = 0;

        const statements = [];
        while (!this.isAtEnd()) {
            console.log(`Parsing statement at token: ${this.peek()?.token.type}`);
            const stmt = this.parseStatement();
            if (stmt) statements.push(stmt);
        }

        return { type: "Program", body: statements } as AST;
    }

    // -- Helper functions --
    /**
     * Retrieves the current token without advancing the position.
     * @returns The current token or null if at the end.
     */
    private peek(): Token | null {
        return this.position < this.tokens.length ? this.tokens[this.position] : null;
    }

    /**
     * Retrieves the previous token.
     * @returns The previous token or null if at the beginning.
     */
    private previous(): Token | null {
        return this.position > 0 ? this.tokens[this.position - 1] : null;
    }

    /**
     * Advances the position and retrieves the previous token.
     * @returns The previous token or null if at the beginning.
     */
    private advance(): Token | null {
        if (!this.isAtEnd()) {
            this.position++;
        }
        return this.previous();
    }

    /**
     * Checks if the parser has reached the end of the token list.
     * @returns True if at the end, false otherwise.
     */
    private isAtEnd(): boolean {
        return this.peek()?.token.type === "EOF";
    }

    /**
     * Checks if the current token matches the specified type or value.
     * @param kind - The kind of check ("type" or "value").
     * @param patterns - The patterns to match against.
     * @returns True if the token matches, false otherwise.
     */
    private checkToken(kind: "type" | "value", patterns: string[]): boolean {
        if (this.isAtEnd()) return false;

        const token = this.peek();
        if (!token) return false;

        if (kind === "type") {
            return patterns.includes(token.token.type);
        } else {
            if (!isValuedTokenType(token.token.type)) return false;
            return patterns.includes((token.token as ValuedToken).value);
        }
    }

    /**
     * Attempts to consume the current token if it matches the specified type or value.
     * @param kind - The kind of check ("type" or "value").
     * @param patterns - The patterns to match against.
     * @returns True if the token was consumed, false otherwise.
     */
    private tryConsume(kind: "type" | "value", patterns: string[]): boolean {
        if (this.checkToken(kind, patterns)) {
            this.advance();
            return true;
        }
        return false;
    }

    /**
     * Consumes the current token if it matches the specified type or value.
     * Reports an error if the token does not match.
     * @param options - The options specifying the type and/or value to match.
     * @param message - The error message to report if the token does not match.
     * @returns The consumed token information or an error token.
     */
    private consume<T extends TokenType>(
        options: { type: T | T[]; value?: string | string[] },
        message: string
    ): { token: TokenInfoFor<T>; start: TokenPos; end: TokenPos } {
        const types = options.type ? (Array.isArray(options.type) ? options.type : [options.type]) : [];
        const values = options.value ? (Array.isArray(options.value) ? options.value : [options.value]) : [];

        if (types.length && this.tryConsume("type", types)) {
            return this.previous() as { token: TokenInfoFor<T>; start: TokenPos; end: TokenPos };
        }
        if (values.length && this.tryConsume("value", values)) {
            return this.previous() as { token: TokenInfoFor<T>; start: TokenPos; end: TokenPos };
        }
        if (!types.length && !values.length) throw new Error("consume() must be called with either type or value");

        const previousToken = this.previous();
        const currentToken = this.peek();

        if (previousToken) {
            this.reporter.add(
                new KatnipError(
                    "Parser",
                    message,
                    {
                        line: previousToken.end.line,
                        column: previousToken.end.column
                    }
                )
            );
        } else if (currentToken) {
            this.reporter.add(
                new KatnipError("Parser", message, currentToken.start)
            );
        }

        return {
            token: { type: "ErrorToken", value: "" } as TokenInfoFor<T>,
            start: { line: -1, column: -1 },
            end: { line: -1, column: -1 }
        };
    }

    private expect<T extends TokenType>(
        options: { type: T | T[]; value?: string | string[] },
        message: string
    ): boolean {
        const types = options.type
            ? (Array.isArray(options.type) ? options.type : [options.type])
            : [];
        const values = options.value
            ? (Array.isArray(options.value) ? options.value : [options.value])
            : [];

        if (
            (types.length && this.checkToken("type", types)) ||
            (values.length && this.checkToken("value", values))
        ) {
            return true;
        }

        const prev = this.previous();
        if (prev) {
            this.reporter.add(
                new KatnipError(
                    "Parser",
                    message,
                    {
                        line: prev.end.line,
                        column: prev.end.column
                    }
                )
            );
        } else if (this.peek()) {
            this.reporter.add(
                new KatnipError("Parser", message, this.peek()!.start)
            );
        }

        return false;
    }

    private synchronize<T extends TokenType>(
        options: { type: T | T[]; value?: string | string[] },
        message: string
    ): void {
        const beginning = this.peek()!.start;
        const types = options.type
            ? (Array.isArray(options.type) ? options.type : [options.type])
            : [];
        const values = options.value
            ? (Array.isArray(options.value) ? options.value : [options.value])
            : [];

        while (this.peek() != null && !this.checkToken("type", types) && !this.checkToken("value", values)) {
            this.advance();
        }

        if (this.peek() == null) {
            this.reporter.add(
                new KatnipError("Parser", message, beginning)
            );
        }
    }

    // -- Statement parsing --
    /** 
     * Parses through and returns a type annotation.
     * @returns The parsed type annotation
     */
    private parseTypeAnnotation(): TypeNode {
        return this.parseUnionType();
    }
    
    private parseUnionType(): TypeNode {
        let left = this.parsePrimaryType();

        while (this.tryConsume("type", ["Pipe"])) {
            const right = this.parsePrimaryType();
            left = {
                type: "UnionType",
                left,
                right,
                loc: { start: left.loc.start, end: right.loc.end }
            };
        }

        return left;
    }

    private parsePrimaryType(): TypeNode {
        const typeNameToken = this.consume({ type: "Identifier" }, "Expected type name");
        const typeName = typeNameToken.token.value;

        if (this.tryConsume("type", ["LeftChevron"])) {
            const typeParams: TypeNode[] = [];

            while (!this.checkToken("type", ["RightChevron"])) {
                typeParams.push(this.parseTypeAnnotation());

                if (
!this.tryConsume("type", ["Comma"]) && !this.checkToken("type", ["RightChevron"])) {
                    this.reporter.add(
                        new KatnipError(
                            "Parser",
                            "Expected ',' or '>'",
                            this.peek()?.start ?? { line: -1, column: -1 }
                        )
                    );
                }
            }

            this.consume({ type: "RightChevron" }, "Expected closing '>'");

            return {
                type: "Type",
                typeName,
                typeParams,
                loc: { start: typeNameToken.start, end: this.previous()!.end }
            };
        }

        return {
            type: "Type",
            typeName,
            loc: { start: typeNameToken.start, end: typeNameToken.end }
        };
    }

    /**
     * Parses a single statement from the token list.
     * @returns The parsed statement or an error token.
     */
    private parseStatement(): StatementNode | null{
        console.log(`parsing statement starting with token: ${this.peek()?.token.type} | value: ${isValuedTokenType(this.peek()?.token.type || "EOF") ? (this.peek()?.token as ValuedToken).value : "N/A"}`);
        if (this.checkToken("value", ["proc"])) return this.parseProcedureDefinition();
        if (this.checkToken("value", ["enum"])) return this.parseEnumDefinition();
        if (this.checkToken("type", ["Comment_SingleExpanded", "Comment_SingleCollapsed", "Comment_MultilineExpanded", "Comment_MultilineCollapsed"])) {
            const comment = (this.peek()?.token as ValuedToken).value;
            this.advance();
            return null;
            // return comment;
        }
        if (this.checkToken("type", ["Identifier"])) {
            if (this.checkToken("value", ["private", "temp", "public"])) {
                return this.parseVariableDeclaration();
            } else {
                // Parse an expression statement
                const expression: ExpressionNode = this.parseExpression();
                if (expression.type == "CallExpression" && this.checkToken("type", ["BraceOpen"])) { // Handler declaration
                    const body = this.parseBlockExpression();
                    return {
                        type: "HandlerDeclaration",
                        call: expression,
                        body: {
                            type: "Block",
                            body: body,
                            loc: { start: body[0]?.loc.start || expression.loc.start, end: body[body.length - 1]?.loc.end || expression.loc.end },
                        },
                        loc: { start: expression.loc.start, end: body[body.length - 1]?.loc.end || expression.loc.end }
                    };
                }
                this.consume({ type: "Semicolon" }, "Expected semicolon at the end of an expression statement");
                return {
                    type: "ExpressionStatement",
                    expression: expression,
                    loc: { start: expression.loc.start, end: expression.loc.end }
                };
            }
        }

        this.reporter.add(
            new KatnipError("Parser", `Unexpected token: Type '${this.peek()!.token.type}'`, this.peek()?.start || { line: -1, column: -1 })
        );
        this.advance();
        return { type: "ErrorStatement", message: "Failed to parse statement", loc: { start: { line: -1, column: -1 }, end: { line: -1, column: -1 } }  } as StatementNode;
    }

    /**
     * Parses a procedure definition from the token list.
     * @returns The parsed procedure declaration node.
     */
    private parseProcedureDefinition(): ProcedureDeclarationNode {
        this.consume({ type: "Identifier", value: "proc" }, "Expected 'proc' keyword");
        const nameToken = this.consume({ type: "Identifier" }, "Expected procedure name");
        const name = nameToken.token.value;

        let parsingDecorators = true;
        const decorators: DecoratorNode[] = [];
        const parameters: ParameterNode[] = [];

        if (this.tryConsume("type", ["ParenOpen"])) {
            while (!this.checkToken("type", ["ParenClose"])) {
                console.log(`parsing proc param/decorator, next token: ${this.peek()?.token.type}, ${this.peek() && isValuedTokenType(this.peek()!.token.type) ? (this.peek()!.token as ValuedToken).value : "N/A"}`);
                if (this.checkToken("type", ["AtSymbol"])) {
                    this.advance();
                } else if (this.checkToken("type", ["Identifier"])) {
                    parsingDecorators = false;
                } else {
                    this.reporter.add(
                        new KatnipError("Parser", "Expected decorator or parameter", this.peek()?.start || { line: -1, column: -1 })
                    );
                }

                if (parsingDecorators) {
                    console.log("parsing decorators");
                    const decoratorNameToken = this.consume({ type: "Identifier" }, "Expected decorator name");
                    const decoratorName = decoratorNameToken.token.value;

                    let decoratorValue;
                    if (!this.expect({ type: ["Equals", "Comma"] }, "Expected '=' or ',' after decorator name")) {
                        this.synchronize({ type: ["Comma", "Equals", "ParenClose"] }, "Failed to parse decorator value");
                    }
                    if (this.tryConsume("type", ["Equals"])) {
                        decoratorValue = this.parseExpression();
                    } else {
                        decoratorValue = {
                            type: "Literal", 
                            value: "true", 
                            valueType: "string", 
                            loc: { 
                                start: decoratorNameToken.start, 
                                end: decoratorNameToken.end 
                            }
                        } as ExpressionNode;
                    }

                    decorators.push({
                            type: "Decorator",
                            name: decoratorName,
                            value: decoratorValue,
                            loc: {
                                start: decoratorValue.loc.start,
                                end: decoratorValue.loc.end
                            }
                        });
                } else {
                    const parameterNameToken = this.consume({ type: "Identifier" }, "Expected parameter name");
                    const parameterName = parameterNameToken.token.value;

                    this.consume({ type: "Colon" }, "Expected ':' after parameter name for type annotation");
                    const parameterTypeToken = this.parseTypeAnnotation();
                    console.log(`Parsed parameter type: ${JSON.stringify(parameterTypeToken)}`);

                    let defaultValueToken;
                    if (this.tryConsume("type", ["Equals"])) {
                        defaultValueToken = this.parseExpression();
                    }

                    parameters.push({
                        type: "Parameter",
                        name: parameterName,
                        paramType: parameterTypeToken,
                        default: defaultValueToken,
                        loc: {
                            start: parameterNameToken.start,
                            end: defaultValueToken?.loc.end || parameterTypeToken.loc.end
                        }
                    });
                }

                if (!this.checkToken("type", ["ParenClose"])) {
                    this.consume(
                        { type: "Comma" },
                        "Expected ',' or ')'"
                    );
                }
            }
            this.consume({ type: "ParenClose" }, "Expected closing parenthesis for parameters");
        }

        console.log("❌ - Finished parsing parameters/decorators");

        this.consume({ type: "Minus" }, "Expected arrow return symbol piece '-'");
        this.consume({ type: "RightChevron" }, "Expected arrow return symbol piece '>' after '-'");

        const returnType = this.parseTypeAnnotation();

        this.consume({ type: "BraceOpen" }, "Expected open curly brace '{' for procedure body");

        const body: StatementNode[] = [];
        while (!this.isAtEnd() && !this.checkToken("type", ["BraceClose"])) {
            const stmt = this.parseStatement();
            if (stmt) body.push(stmt);
        }

        this.consume({ type: "BraceClose" }, "Expected closing curly brace '}' for procedure body");

        return {
            type: "ProcedureDeclaration",
            name,
            decorators,
            parameters,
            returnType,
            body,
            loc: {
                start: nameToken.start,
                end: this.peek()?.end || { line: -1, column: -1 }
            }
        };
    }

    /**
     * Parses an enum definition from the token list.
     * @returns The parsed enum declaration node.
     */
    private parseEnumDefinition(): EnumDeclarationNode {
        this.consume({ type: "Identifier", value: "enum" }, "Expected 'enum' keyword");
        const nameToken = this.consume({ type: "Identifier" }, "Expected enum name");
        const name = nameToken.token.value;

        this.consume({ type: "BraceOpen" }, "Expected opening brace for enum members");
        const members: string[] = [];
        while (!this.checkToken("type", ["BraceClose"])) {
            const memberToken = this.consume({ type: "Identifier" }, "Expected enum member name");
            members.push(memberToken.token.value);

            if (!this.tryConsume("type", ["Comma"]) && !this.checkToken("type", ["BraceClose"])) {
                this.reporter.add(
                    new KatnipError("Parser", "Expected ',' or ')'", this.peek()?.start || { line: -1, column: -1 })
                );
            }
        }
        this.consume({ type: "BraceClose" }, "Expected closing brace for enum members");

        return {
            type: "EnumDeclaration",
            name: name,
            members: members,
            loc: {
                start: nameToken.start,
                end: this.peek()?.end || { line: -1, column: -1 }
            }
        };
    }

    /**
     * Parses a variable declaration from the token list.
     * @returns The parsed variable declaration node.
     */
    private parseVariableDeclaration(): VariableDeclarationNode {
        console.log(`parsing variable declaration starting with token: ${this.peek()?.token.type}`);
        const access = this.consume({ type: "Identifier", value: Object.values(VariableDeclarationType) }, "Expected 'private', 'temp', or 'public' keyword");
        const variableName = this.consume({ type: "Identifier" }, "Expected variable name");
        this.consume({ type: "Colon" }, "Expected ':' after variable name for type annotation");
        const typeAnnotation = this.parseTypeAnnotation();
        this.consume({ type: "Equals" }, "Expected '=' after type annotation for variable declaration");
        const initializer = this.parseExpression();
        this.consume({ type: "Semicolon" }, "Expected ';' at the end of variable declaration");

        return {
            type: "VariableDeclaration",
            access: access.token.value as VariableDeclarationType,
            name: variableName.token.value,
            varType: typeAnnotation,
            initializer: initializer,
            loc: {
                start: access.start,
                end: this.peek()?.end || { line: -1, column: -1 }
            }
        };
    }

    // private parseVariableAssignment(): 

    /**
     * Parses an expression from the token list.
     * @returns The parsed expression node.
     */
    private parseExpression(minBP = 0): ExpressionNode {
        console.log(`PREfix operator: ${this.peek()?.token.type}`);
        let left = this.parsePrefix();

        while (true) {
            const token = this.peek();
            if (!token) break;

            const bp = getBindingPower(token);
            if (!bp || bp.lbp <= minBP) break;

            //this.advance();
            console.log(`Infix operator: ${this.peek()?.token.type}`);
            left = this.parseInfix(left, bp);
        }

        console.log(`QUIT on: ${this.peek()?.token.type}`);

        return left;
    }

    /**
     * Parses the prefix part of an expression.
     * @returns The parsed expression node.
     */
    private parsePrefix(): ExpressionNode {
        const token = this.peek();
        if (!token) return { type: "ErrorToken", value: "", loc: { start: { line: -1, column: -1 }, end: { line: -1, column: -1 } } } as ExpressionNode;

        const value = token.token.type;

        // Unary operators
        if (value === "Exclamation" || value === "Minus") {
            this.advance();
            const opKey = value === "Minus" ? "UnaryMinus" : value;
            const { rbp } = bindingPowerTable[opKey];
            const right = this.parseExpression(rbp);
            return {
                type: "UnaryExpression",
                operator: value,
                argument: right,
                loc: { start: token.start, end: right.loc?.end || token.end },
            } as ExpressionNode;
        }

        // Parenthesized expression
        if (this.tryConsume("type", ["ParenOpen"])) {
            if (this.checkToken("type", ["ParenClose"])) {
                this.advance();
                return { type: "EmptyExpression", loc: { start: token.start, end: this.previous()!.end } }
            }

            const expr = this.parseExpression();
            this.consume({ type: "ParenClose" }, "Expected ')' after parenthesized expression");
            return expr;
        }

        // Bracket expression
        if (this.tryConsume("type", ["BracketOpen"])) {
            const listContents: ExpressionNode[] = [];
            while (!this.checkToken("type", ["Comma", "BracketClose"])) {
                listContents.push(this.parseExpression());
                this.tryConsume("type", ["Comma"]);
            }

            this.consume({ type: "BracketClose" }, "Expected ']' after list expression");
            return {
                type: "ListExpression",
                elements: listContents,
                loc: { start: token.start, end: this.previous()!.end }
            };
        }

        // Dictionary expression
        if (this.tryConsume("type", ["BraceOpen"])) {
            const dictionaryContents: DictEntryNode[] = [];
            while (!this.checkToken("type", ["Comma", "BraceClose"])) {
                const key = this.parseExpression();
                this.consume({ type: "Colon" }, "Expected ':' between dictionary key and value");
                const value = this.parseExpression();
                dictionaryContents.push({ key, value });
                this.tryConsume("type", ["Comma"]);
            }

            this.consume({ type: "BraceClose" }, "Expected '}' after dictionary expression");
            return {
                type: "DictExpression",
                entries: dictionaryContents,
                loc: { start: token.start, end: this.previous()!.end }
            };
        }

        // Identifiers
        if (this.checkToken("type", ["Identifier"])) {
            const id = this.consume({ type: "Identifier" }, "Expected identifier");
            return {
                type: "Identifier",
                name: id.token.value,
                loc: { start: id.start, end: id.end },
            } as ExpressionNode;
        }

        // String literal
        if (this.checkToken("type", ["String"])) {
            const lit = this.consume({ type: "String" }, "Expected string literal");
            return {
                type: "Literal",
                value: lit.token.value,
                valueType: "string",
                loc: { start: lit.start, end: lit.end },
            } as ExpressionNode;
        }

        // Number literal
        if (this.checkToken("type", ["Number"])) {
            const lit = this.consume({ type: "Number" }, "Expected number literal");
            return {
                type: "Literal",
                value: Number(lit.token.value),
                valueType: "number",
                loc: { start: lit.start, end: lit.end },
            } as ExpressionNode;
        }

        // EOF
        if (this.checkToken("type", ["EOF"])) {
            return { type: "ErrorToken", value: "", loc: { start: token.start, end: token.end } } as ExpressionNode;
        }

        // Fallback error
        const unexpectedToken = token.token.type;
        const unexpectedValue = isValuedTokenType(unexpectedToken) ? (token.token as ValuedToken).value : null;
        this.reporter.add(new KatnipError(
            "Parser",
            `Unexpected token in expression: Type '${unexpectedToken}'${unexpectedValue ? `, Value '${unexpectedValue}'` : ''}`,
            token.start
        ));

        this.advance();
        return { type: "ErrorToken", value: "", loc: { start: token.start, end: token.end } } as ExpressionNode;
    }

    /**
     * Parses the infix part of an expression.
     * @returns The parsed expression node.
     */
    private parseInfix(
        left: ExpressionNode,
        bp: { lbp: number; rbp: number }
    ): ExpressionNode {
        const token = this.peek();
        if (!token) {
            this.reporter.add(new KatnipError("Parser", "Unexpected end of input in infix expression", left.loc?.end || { line: -1, column: -1 }));
            return { type: "ErrorToken", value: "", loc: left.loc || { start: { line: -1, column: -1 }, end: { line: -1, column: -1 } } } as ExpressionNode;
        }
        const tokenType = token.token.type;

        // Function call: token type is ParenOpen
        if (tokenType === "ParenOpen") {
            this.advance();
            const args: ExpressionNode[] = [];
            if (!this.checkToken("type", ["ParenClose"])) {
                do {
                    args.push(this.parseExpression());
                } while (this.tryConsume("type", ["Comma"]));
            }
            this.consume({ type: "ParenClose" }, "Expected ')' after parameters");

            return {
                type: "CallExpression",
                callee: left,
                arguments: args,
                loc: { start: left.loc.start, end: this.peek()?.end || token.end },
            };
        }

        // Member access: token type is Dot
        if (tokenType === "Dot") {
            this.advance();
            const id = this.consume({ type: "Identifier" }, "Expected property name after '.'");
            return {
                type: "MemberExpression",
                object: left,
                property: { type: "Identifier", name: id.token.value, loc: { start: id.start, end: id.end } },
                loc: { start: left.loc.start, end: id.end },
            } as ExpressionNode;
        }

        // Binary operator (fallback). Use binding power to parse right-hand side.
        const tokenValue = isValuedTokenType(token.token.type)
            ? (token.token as ValuedToken).value
            : token.token.type;
        
        this.advance();
        const right = this.parseExpression(bp.rbp);
        return {
            type: "BinaryExpression",
            operator: tokenValue,
            left,
            right,
            loc: { start: left.loc.start, end: right.loc.end },
        } as ExpressionNode;
    }

    /**
     * Parses a block expression following a method call.
     * @returns The parsed block expression node.
     */
    private parseBlockExpression(): StatementNode[] {
        this.consume({ type: "BraceOpen" }, "Expected '{' after method call");
        const body: StatementNode[] = [];

        while (!this.isAtEnd() && !this.checkToken("type", ["BraceClose"])) {
            const stmt = this.parseStatement();
            if (stmt) body.push(stmt);
        }

        this.consume({ type: "BraceClose" }, "Expected '}' to close block");

        return body;
    }
}
