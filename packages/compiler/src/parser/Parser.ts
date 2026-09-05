/**
 * @fileoverview Contains the main parser class for the Katnip compiler.
 */

import { isValuedTokenType, UnitTokenType } from "../lexer/Token.js";
import type { Token, TokenInfoFor, TokenPos, TokenType, ValuedToken } from "../lexer/Token.js";
import { ErrorReporter, KatnipError } from "../utils/ErrorReporter.js";
import { KatnipLog, KatnipLogType, Logger } from "../utils/Logger.js";
import { type AST, type DecoratorNode, type ParameterNode, type ProcedureDeclarationNode, type TypeNode, type TupleTypeNode, type NamedArgumentNode, type ExpressionNode, type StatementNode, type EnumDeclarationNode, type EnumMemberNode, type StructDeclarationNode, type StructFieldNode, type VariableDeclarationNode, VariableDeclarationType, type VariableAssignmentNode, type DictEntryNode, type ElifClauseNode, type BlockNode, type CaseDeclarationNode, type DefaultCaseDeclarationNode, type BinaryOperator, type AssignmentOperator, type UnaryOperator } from "./AST-nodes.js";
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
        this.logger.print(new KatnipLog(KatnipLogType.Info, `--- Parsing started with ${tokens.length} tokens ---`));
        this.tokens = tokens;
        this.position = 0;

        const statements = [];
        while (!this.isAtEnd()) {
            const before = this.position;
            this.logger.log(new KatnipLog(KatnipLogType.Debug, `Parsing statement at token: ${this.peek()?.token.type}`));
            const stmt = this.parseStatement();
            if (stmt) statements.push(stmt);

            if (this.position === before) {
                this.reporter.add(
                    new KatnipError(
                    "Parser",
                    `Parser got stuck on token '${this.peek()?.token.type}'`,
                    this.peek()?.start ?? { line: -1, column: -1 },
                    ),
                );
                this.advance();
            }
        }

        return { type: "Program", body: statements } as AST;
    }

    // -- Helper functions --
    /**
     * Retrieves the current token without advancing the position.
     * @param lookAhead - Number of tokens to look ahead.
     * @returns The current token or null if at the end.
     */
    private peek(lookAhead: number = 0): Token | null {
        const index = this.position + lookAhead;
        return index < this.tokens.length ? this.tokens[index] : null;
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
        return this.peek()?.token.type === "<EOF>";
    }

    /**
     * Checks if the current token matches the specified type or value.
     * @param kind - The kind of check ("type" or "value").
     * @param patterns - The patterns to match against.
     * @returns True if the token matches, false otherwise.
     */
    private checkToken(kind: "type", patterns: TokenType[]): boolean;
    private checkToken(kind: "value", patterns: string[]): boolean;
    private checkToken(kind: "type" | "value", patterns: (string | TokenType)[]): boolean {
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
    private tryConsume<K extends "type" | "value">(
        kind: K,
        patterns: (K extends "type" ? TokenType : string)[]
    ): boolean {
        if (this.checkToken(kind as "type", patterns as TokenType[])) {
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
        message: string,
        sync?: { type: TokenType | TokenType[]; value?: string | string[] }
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

        const before = this.position;

        if (sync) {
            this.synchronize(sync, "Failed to synchronize after consume error");
        }

        if (this.position === before && !this.isAtEnd()) {
            this.advance();
        }

        return {
            token: { type: "ErrorToken", value: "" } as TokenInfoFor<T>,
            start: { line: -1, column: -1 },
            end: { line: -1, column: -1 }
        };
    }

    /**
     * Checks whether the current token matches without consuming it.
     * Reports an error if it does not match.
     * @param options - Token type/value options to check.
     * @param message - Error message to report on failure.
     * @returns True when the token matches, false otherwise.
     */
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

    /**
     * Advances tokens until a matching type/value is found or EOF is reached.
     * Reports an error if the end is reached without finding a match.
     * @param options - Token type/value options to synchronize on.
     * @param message - Error message to report on failure.
     */
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

        const before = this.position;

        while (this.peek() != null && !this.checkToken("type", types) && !this.checkToken("value", values)) {
            this.advance();
        }

        if (this.position === before && this.peek() != null) {
            this.advance();
        }

        if (this.peek() == null) {
            this.reporter.add(
                new KatnipError("Parser", message, beginning)
            );
        }
    }

    /**
     * Consumes a statement-terminating ';'. 
     * If it is missing, reports the errorbut does NOT advance.
     * The current token starts the next statement.
     */
    private expectSemicolon(message: string): void {
        if (this.tryConsume("type", [";"])) return;
        const prev = this.previous();
        this.reporter.add(
            new KatnipError(
                "Parser",
                message,
                prev
                    ? { line: prev.end.line, column: prev.end.column }
                    : this.peek()?.start ?? { line: -1, column: -1 },
            ),
        );
    }

    // -- Statement parsing --
    /** 
     * Parses through and returns a type annotation.
     * @returns The parsed type annotation
     */
    private parseTypeAnnotation(): TypeNode {
        return this.parseUnionType();
    }
    
    /**
     * Parses a union type expression (e.g., A | B).
     * @returns The parsed type node.
     */
    private parseUnionType(): TypeNode {
        let left = this.parsePrimaryType();

        while (this.tryConsume("type", ["|"])) {
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

    /**
     * Parses a primary type, including optional generic parameters.
     * @returns The parsed type node.
     */
    private parsePrimaryType(): TypeNode {
        if (this.checkToken("type", ["("])) {
            return this.parseTupleType();
        }

        const typeNameToken = this.consume({ type: "Identifier" }, "Expected type name");
        const typeName = typeNameToken.token.value;

        if (this.tryConsume("type", ["<"])) {
            const typeParams: TypeNode[] = [];

            while (!this.isAtEnd() && !this.checkToken("type", [">"])) {
                typeParams.push(this.parseTypeAnnotation());

                if (!this.tryConsume("type", [","]) && !this.checkToken("type", [">"])) {
                    this.reporter.add(
                        new KatnipError(
                            "Parser",
                            "Expected ',' or '>'",
                            this.peek()?.start ?? { line: -1, column: -1 }
                        )
                    );
                }
            }

            this.consume({ type: ">" }, "Expected closing '>'");

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
     * Parses a tuple type, e.g. (str, num). Used for fixed-shape sequences
     * like the element type of list<(str, num)>.
     * @returns The parsed tuple type node.
     */
    private parseTupleType(): TupleTypeNode {
        const open = this.consume({ type: "(" }, "Expected '(' for tuple type");
        const elements: TypeNode[] = [];

        if (!this.checkToken("type", [")"])) {
            do {
                elements.push(this.parseTypeAnnotation());
            } while (this.tryConsume("type", [","]));
        }

        const close = this.consume({ type: ")" }, "Expected ')' to close tuple type");
        return {
            type: "TupleType",
            elements,
            loc: { start: open.start, end: close.end }
        };
    }

    /**
     * Parses a single statement from the token list.
     * @returns The parsed statement or an error token.
     */
    private parseStatement(): StatementNode | null{
        this.logger.log(new KatnipLog(KatnipLogType.Debug, `parsing statement starting with token: ${this.peek()?.token.type} | value: ${isValuedTokenType(this.peek()?.token.type || "<EOF>") ? (this.peek()?.token as ValuedToken).value : "N/A"}`));
        if (this.checkToken("type", ["Comment_SingleExpanded", "Comment_SingleCollapsed", "Comment_MultilineExpanded", "Comment_MultilineCollapsed"])) {
            this.advance();
            return null;
        }
        if (this.checkToken("type", ["Identifier", "("])) {
            if (this.checkToken("value", ["proc"]) && !(this.peek(1)?.token.type === ".")) return this.parseProcedureDefinition();
            if (this.checkToken("value", ["enum"])) return this.parseEnumDefinition();
            if (this.checkToken("value", ["struct"])) return this.parseStructDefinition();
            if (this.checkToken("value", ["private", "public"])) {
                const next = this.peek(1)?.token;
                const nextVal = next && isValuedTokenType(next.type) ? (next as ValuedToken).value : undefined;
                if (nextVal === "proc") return this.parseProcedureDefinition();
                if (nextVal === "enum") return this.parseEnumDefinition();
                if (nextVal === "struct") return this.parseStructDefinition();
                return this.parseVariableDeclaration();
            }
            if (this.checkToken("value", ["sprite", "stage"])) return this.parseSpriteDefinition(this.checkToken("value", ["stage"]));
            if (this.checkToken("value", ["import"])) return this.parseImportLike("import");
            if (this.checkToken("value", ["costume"])) return this.parseImportLike("costume");
            if (this.checkToken("value", ["sound"])) return this.parseImportLike("sound");

            if (this.checkToken("value", ["if"])) return this.parseIfStatement();
            if (this.checkToken("value", ["for"])) return this.parseForStatement();
            if (this.checkToken("value", ["while"])) return this.parseWhileStatement();
            if (this.checkToken("value", ["do"])) return this.parseDoWhileStatement();
            if (this.checkToken("value", ["forever"])) return this.parseForeverStatement();
            if (this.checkToken("value", ["return"])) return this.parseReturnStatement();

            if (this.checkToken("value", ["switch"])) return this.parseSwitchStatement();
            if (this.checkToken("value", ["case"])) return this.parseCaseStatement();
            if (this.checkToken("value", ["default"])) return this.parseDefaultCaseStatement();

            // Parse an expression statement
            const expression: ExpressionNode = this.parseExpression();
            const assignmentExpression = this.parseAssignmentExpression(expression);
            if (assignmentExpression) {
                return assignmentExpression;
            }

            const handlerDeclaration = this.parseHandlerDeclaration(expression);
            if (handlerDeclaration) {
                return handlerDeclaration;
            }

            this.expectSemicolon("Expected semicolon at the end of an expression statement");
            return {
                type: "ExpressionStatement",
                expression: expression,
                loc: { start: expression.loc.start, end: expression.loc.end }
            };
        }

        this.reporter.add(
            new KatnipError("Parser", `Unexpected token: Type '${this.peek()!.token.type}'`, this.peek()?.start || { line: -1, column: -1 })
        );
        this.advance();
        return { type: "ErrorStatement", message: "Failed to parse statement", loc: { start: { line: -1, column: -1 }, end: { line: -1, column: -1 } }  } as StatementNode;
    }

    /**
     * Parses a return statement: `return;` or `return <expression>;`.
     * @returns The parsed return statement node.
     */
    private parseReturnStatement(): StatementNode {
        const keyword = this.consume({ type: "Identifier", value: "return" }, "Expected 'return' keyword");
        let argument: ExpressionNode | null = null;
        if (!this.checkToken("type", [";"])) {
            argument = this.parseExpression();
        }
        this.expectSemicolon("Expected ';' at the end of return statement");
        return {
            type: "ReturnStatement",
            argument,
            loc: { start: keyword.start, end: this.previous()?.end || keyword.end },
        };
    }

    /**
     * Parses an optional leading access modifier (`public`/`private`).
     * Defaults to `private`. `start` is the modifier's position (or null) to anchor at loc.
     */
    private parseAccessModifier(): { access: VariableDeclarationType; start: TokenPos | null } {
        if (this.checkToken("value", ["private", "public"])) {
            const tok = this.consume({ type: "Identifier", value: Object.values(VariableDeclarationType) }, "Expected access modifier");
            return { access: tok.token.value as VariableDeclarationType, start: tok.start };
        }
        return { access: VariableDeclarationType.private, start: null };
    }

    /**
     * Parses a procedure definition from the token list.
     * @returns The parsed procedure declaration node.
     */
    private parseProcedureDefinition(): ProcedureDeclarationNode {
        const { access, start: accessStart } = this.parseAccessModifier();
        this.consume({ type: "Identifier", value: "proc" }, "Expected 'proc' keyword");
        const nameToken = this.consume({ type: "Identifier" }, "Expected procedure name");
        const name = nameToken.token.value;

        let parsingDecorators = true;
        const decorators: DecoratorNode[] = [];
        const parameters: ParameterNode[] = [];

        if (this.tryConsume("type", ["("])) {
            while (!this.isAtEnd() && !this.checkToken("type", [")"])) {
                this.logger.log(new KatnipLog(KatnipLogType.Debug, `parsing proc param/decorator, next token: ${this.peek()?.token.type}, ${this.peek() && isValuedTokenType(this.peek()!.token.type) ? (this.peek()!.token as ValuedToken).value : "N/A"}`));
                if (this.checkToken("type", ["@"])) {
                    if (!parsingDecorators) {
                        this.reporter.add(
                            new KatnipError("Parser", "Decorators must come before parameters", this.peek()!.start)
                        );
                        parsingDecorators = true;
                    }
                    this.advance();
                } else if (this.checkToken("type", ["Identifier"])) {
                    parsingDecorators = false;
                } else {
                    this.reporter.add(
                        new KatnipError("Parser", "Expected decorator or parameter", this.peek()?.start || { line: -1, column: -1 })
                    );
                }

                if (parsingDecorators) {
                    this.logger.log(new KatnipLog(KatnipLogType.Debug, "parsing decorators"));
                    const decoratorNameToken = this.consume({ type: "Identifier" }, "Expected decorator name");
                    const decoratorName = decoratorNameToken.token.value;

                    let decoratorValue;
                    if (!this.expect({ type: ["=", ",", ")"] }, "Expected '=', ',' or ')' after decorator name")) {
                        this.synchronize({ type: [",", "=", ")"] }, "Failed to parse decorator value");
                    }
                    if (this.tryConsume("type", ["="])) {
                        decoratorValue = this.parseExpression();
                    } else {
                        decoratorValue = {
                            type: "Literal", 
                            value: "true", 
                            valueType: "String", 
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

                    this.consume({ type: ":" }, "Expected ':' after parameter name for type annotation");
                    const parameterTypeToken = this.parseTypeAnnotation();
                    this.logger.log(new KatnipLog(KatnipLogType.Debug, `Parsed parameter type: ${JSON.stringify(parameterTypeToken)}`));

                    let defaultValueToken;
                    if (this.tryConsume("type", ["="])) {
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

                if (!this.checkToken("type", [")"])) {
                    this.consume(
                        { type: "," },
                        "Expected ',' or ')'",
                        { type: [",", ")"] }
                    );
                }
            }
            this.consume({ type: ")" }, "Expected closing parenthesis for parameters");
        }

        this.logger.log(new KatnipLog(KatnipLogType.Debug, "❌ - Finished parsing parameters/decorators"));

        this.consume({ type: "->" }, "Expected arrow return symbol '->'");

        const returnType = this.parseTypeAnnotation();

        this.consume({ type: "{" }, "Expected open curly brace '{' for procedure body");

        const stmts: StatementNode[] = [];
        while (!this.isAtEnd() && !this.checkToken("type", ["}"])) {
            const stmt = this.parseStatement();
            if (stmt) stmts.push(stmt);
        }

        this.consume({ type: "}" }, "Expected closing curly brace '}' for procedure body");

        const body: BlockNode = {
            type: "Block",
            body: stmts,
            loc: { start: stmts[0]?.loc.start || nameToken.start, end: stmts[stmts.length - 1]?.loc.end || nameToken.start }
        };

        return {
            type: "ProcedureDeclaration",
            access,
            name,
            decorators,
            parameters,
            returnType,
            body,
            loc: {
                start: accessStart ?? nameToken.start,
                end: this.previous()?.end || { line: -1, column: -1 }
            }
        };
    }

    /**
     * Parses an enum definition from the token list.
     * @returns The parsed enum declaration node.
     */
    private parseEnumDefinition(): EnumDeclarationNode {
        const { access, start: accessStart } = this.parseAccessModifier();
        this.consume({ type: "Identifier", value: "enum" }, "Expected 'enum' keyword");
        const nameToken = this.consume({ type: "Identifier" }, "Expected enum name");
        const name = nameToken.token.value;

        this.consume({ type: "{" }, "Expected opening brace for enum members");
        const members: EnumMemberNode[] = [];
        while (!this.isAtEnd() && !this.checkToken("type", ["}"])) {
            const memberToken = this.consume({ type: "Identifier" }, "Expected enum member name");
            const memberName = memberToken.token.value;

            let value: string | number = memberName;
            if (this.tryConsume("type", ["="])) {
                if (this.checkToken("type", ["String"])) {
                    value = (this.advance()!.token as ValuedToken).value;
                } else if (this.checkToken("type", ["Number"])) {
                    value = Number((this.advance()!.token as ValuedToken).value);
                } else {
                    this.reporter.add(
                        new KatnipError("Parser", "Expected string or number literal for enum member value", this.peek()?.start || { line: -1, column: -1 })
                    );
                }
            }
            members.push({ name: memberName, value });

            if (!this.tryConsume("type", [","]) && !this.checkToken("type", ["}"])) {
                this.reporter.add(
                    new KatnipError("Parser", "Expected ',' or '}'", this.peek()?.start || { line: -1, column: -1 })
                );
            }
        }
        this.consume({ type: "}" }, "Expected closing brace for enum members");

        return {
            type: "EnumDeclaration",
            access,
            name: name,
            members: members,
            loc: {
                start: accessStart ?? nameToken.start,
                end: this.previous()?.end || { line: -1, column: -1 }
            }
        };
    }

    /**
     * Parses a struct definition: `struct Name { a: num, b = 0, c: str = "x" }`.
     * Each field needs a type annotation or a default (or both).
     * @returns The parsed struct declaration node.
     */
    private parseStructDefinition(): StructDeclarationNode {
        const { access, start: accessStart } = this.parseAccessModifier();
        this.consume({ type: "Identifier", value: "struct" }, "Expected 'struct' keyword");
        const nameToken = this.consume({ type: "Identifier" }, "Expected struct name");
        const name = nameToken.token.value;

        this.consume({ type: "{" }, "Expected opening brace for struct fields");
        const fields: StructFieldNode[] = [];
        while (!this.isAtEnd() && !this.checkToken("type", ["}"])) {
            const fieldToken = this.consume({ type: "Identifier" }, "Expected struct field name");
            const fieldName = fieldToken.token.value;

            let fieldType: TypeNode | null = null;
            let fieldDefault: ExpressionNode | null = null;
            if (this.tryConsume("type", [":"])) {
                fieldType = this.parseTypeAnnotation();
                if (this.tryConsume("type", ["="])) fieldDefault = this.parseExpression();
            } else if (this.tryConsume("type", ["="])) {
                fieldDefault = this.parseExpression();
            } else {
                this.reporter.add(
                    new KatnipError("Parser", `Struct field '${fieldName}' needs a type annotation or a default value`, fieldToken.start)
                );
            }
            fields.push({
                type: "StructField",
                name: fieldName,
                fieldType,
                default: fieldDefault,
                loc: { start: fieldToken.start, end: this.previous()?.end || fieldToken.end },
            });

            if (!this.tryConsume("type", [","]) && !this.checkToken("type", ["}"])) {
                this.reporter.add(
                    new KatnipError("Parser", "Expected ',' or '}'", this.peek()?.start || { line: -1, column: -1 })
                );
            }
        }
        this.consume({ type: "}" }, "Expected closing brace for struct fields");

        return {
            type: "StructDeclaration",
            access,
            name,
            fields,
            loc: {
                start: accessStart ?? nameToken.start,
                end: this.previous()?.end || { line: -1, column: -1 },
            },
        };
    }

    /**
     * Parses a variable declaration from the token list.
     * @returns The parsed variable declaration node.
     */
    private parseVariableDeclaration(): VariableDeclarationNode {
        this.logger.log(new KatnipLog(KatnipLogType.Debug, `parsing variable declaration starting with token: ${this.peek()?.token.type}`));
        const access = this.consume({ type: "Identifier", value: Object.values(VariableDeclarationType) }, "Expected 'private' or 'public' keyword");
        const variableName = this.consume({ type: "Identifier" }, "Expected variable name");

        // Valid fomations: no type + yes init, yes type + yes init, yes type + no init
        // INvalid formations: no type + no init
        let typeAnnotation = null;
        let initializer = null;
        if (this.tryConsume("type", [":"])) {
            typeAnnotation = this.parseTypeAnnotation();
            if (this.tryConsume("type", ["="])) {
                initializer = this.parseExpression();
            }
        } else {
            this.consume({ type: "=" }, "Expected '=' for variable value declaration");
            initializer = this.parseExpression();
        }
        this.expectSemicolon("Expected ';' at the end of variable declaration");
        return {
            type: "VariableDeclaration",
            access: access.token.value as VariableDeclarationType,
            name: variableName.token.value,
            varType: typeAnnotation,
            initializer: initializer,
            loc: {
                start: access.start,
                end: this.previous()?.end || { line: -1, column: -1 }
            }
        };
    }

    /** Parses `import "./thing.knip";` or `import "../sub/thing.knip" as thing;` */
    private parseImportLike(type: "import" | "costume" | "sound"): StatementNode {
        const keyword = this.consume({ type: "Identifier", value: type}, `Expected ${type} keyword`);
        const specifier = this.consume({ type: "String" }, `Expected a quoted path after '${type}'`);

        let alias: string | undefined;
        if (this.checkToken("value", ["as"])) {
            this.advance();
            alias = this.consume({ type: "Identifier" }, "Expected a namespace name after 'as'").token.value;
        }

        this.expectSemicolon(`Expected ';' at the end of a${type === "import" ? "n" : ""} ${type} declaration`);
        if (type === "import")
            return {
                type: "ImportDeclaration",
                specifier: specifier.token.value,
                specifierLoc: { start: specifier.start, end: specifier.end },
                alias,
                loc: { start: keyword.start, end: this.previous()?.end || keyword.start },
            };
        else
            return {
                type: "AssetDeclaration",
                kind: type,
                specifier: specifier.token.value,
                specifierLoc: { start: specifier.start, end: specifier.end },
                alias,
                loc: { start: keyword.start, end: this.previous()?.end || keyword.start },
            };
    }

    private parseSpriteDefinition(isStage: boolean): StatementNode {
        let name: string;
        let nameToken: { token: TokenInfoFor<"Identifier">; start: TokenPos; end: TokenPos };

        if (isStage) {
            nameToken = this.consume({ type: "Identifier" }, "Expected 'stage' keyword");
            name = "stage";
        } else {
            this.consume({ type: "Identifier", value: "sprite" }, "Expected 'sprite' keyword");
            nameToken = this.consume({ type: "Identifier" }, "Expected sprite name");
            name = nameToken.token.value;
            // Codegen maps the name "stage" onto the stage target, so a sprite may not claim it.
            if (name === "stage")
                this.reporter.add(new KatnipError("Parser", "'stage' is reserved; use a `stage { }` block to add code to the stage", nameToken.start));
        }

        const stmts = this.parseBlockExpression();
        const body: BlockNode = {
            type: "Block",
            body: stmts,
            loc: { start: stmts[0]?.loc.start || nameToken.start, end: stmts[stmts.length - 1]?.loc.end || nameToken.start }
        };

        return {
            type: "SpriteDeclaration",
            name,
            body,
            loc: { start: nameToken.start, end: this.previous()?.end || nameToken.start }
        }
    }

    /**
     * Parses an assignment expression using a previously parsed left-hand side.
     * @param left - The expression to assign into.
     * @returns The assignment node or null if no assignment operator follows.
     */
    private parseAssignmentExpression(left: ExpressionNode): VariableAssignmentNode | null {
        if (!this.checkToken("type", ["=", "+=", "-=", "*=", "/=", "%=", "**="])) {
            return null;
        }

        const assginmentOperator = this.consume({ type: [
            UnitTokenType.Equals, 
            UnitTokenType.PlusEquals, 
            UnitTokenType.MinusEquals, 
            UnitTokenType.AsteriskEquals, 
            UnitTokenType.FwdSlashEquals, 
            UnitTokenType.PercentEquals, 
            UnitTokenType.PowerEquals
        ] }, "Expected assignment operator").token.type;
        
        const right = this.parseExpression();
        this.expectSemicolon("Expected semicolon at the end of an expression statement");

        return {
            type: "VariableAssignment",
            operator: assginmentOperator as AssignmentOperator,
            left: left,
            right: right,
            loc: { start: left.loc.start, end: right.loc.end }
        };
    }

    /**
     * Parses a handler declaration following a call expression.
     * @param left - The call expression that starts the handler declaration.
     * @returns The handler declaration node or null if not applicable.
     */
    private parseHandlerDeclaration(left: ExpressionNode): StatementNode | null {
        if (left.type == "CallExpression" && this.checkToken("type", ["{"])) {
            const body = this.parseBlockExpression();
            
            return {
                type: "HandlerStatement",
                call: left,
                body: {
                    type: "Block",
                    body: body,
                    loc: {
                        start: body[0]?.loc.start || left.loc.start,
                        end: body[body.length - 1]?.loc.end || left.loc.end,
                    },
                },
                loc: {
                    start: left.loc.start,
                    end: body[body.length - 1]?.loc.end || left.loc.end,
                },
            };
        }
        return null;
    }

    /**
     * Parses a for statement from the token list.
     * @returns The parsed for statement node.
     */
    private parseForStatement(): StatementNode {
        this.consume({ type: "Identifier", value: "for" }, "Expected 'for' keyword");
        this.consume({ type: "(" }, "Expected '(' after 'for'");

        const rawPattern = this.parseExpression();
        let pattern: ExpressionNode;
        if (rawPattern.type === "Identifier" || rawPattern.type === "TupleExpression") {
            pattern = rawPattern;
        } else {
            this.reporter.add(
                new KatnipError(
                    "Parser",
                    "Expected identifier or tuple pattern in for loop",
                    rawPattern.loc.start
                )
            );
            pattern = {
                type: "Identifier",
                name: "_",
                loc: rawPattern.loc
            } as ExpressionNode;
        }

        this.consume({ type: "," }, "Expected ',' after for loop pattern");
        const iterable = this.parseExpression();
        this.consume({ type: ")" }, "Expected ')' after for loop iterable");

        const bodyExpression = this.parseBlockExpression();
        const body = {
            type: "Block",
            body: bodyExpression,
            loc: {
                start: bodyExpression[0]?.loc.start || iterable.loc.end,
                end: bodyExpression[bodyExpression.length - 1]?.loc.end || iterable.loc.end
            }
        } satisfies BlockNode;

        return {
            type: "ForStatement",
            pattern: pattern as Extract<ExpressionNode, { type: "Identifier" | "TupleExpression" }>,
            iterable,
            body,
            loc: {
                start: pattern.loc.start,
                end: body.loc.end
            }
        };
    }

    /**
     * Parses a while statement from the token list.
     * @returns The parsed while statement node.
     */
    private parseWhileStatement(): StatementNode {
        this.consume({ type: "Identifier", value: "while" }, "Expected 'while' keyword");
        this.consume({ type: "(" }, "Expected '(' after 'while'");
        const condition = this.parseExpression();
        this.consume({ type: ")" }, "Expected ')' after while condition");

        const bodyExpression = this.parseBlockExpression();
        const body = {
            type: "Block",
            body: bodyExpression,
            loc: {
                start: bodyExpression[0]?.loc.start || condition.loc.end,
                end: bodyExpression[bodyExpression.length - 1]?.loc.end || condition.loc.end
            }
        } satisfies BlockNode;

        return {
            type: "WhileStatement",
            condition,
            body,
            loc: {
                start: condition.loc.start,
                end: body.loc.end
            }
        };
    }

    /**
     * Parses `forever { ... }`.
     */
    private parseForeverStatement(): StatementNode {
        const keyword = this.consume({ type: "Identifier", value: "forever" }, "Expected 'forever' keyword");
        const bodyExpression = this.parseBlockExpression();
        const body = {
            type: "Block",
            body: bodyExpression,
            loc: {
                start: bodyExpression[0]?.loc.start || keyword.end,
                end: bodyExpression[bodyExpression.length - 1]?.loc.end || keyword.end
            }
        } satisfies BlockNode;

        return { type: "ForeverStatement", body, loc: { start: keyword.start, end: body.loc.end } };
    }

    /**
     * Parses a do-while statement from the token list.
     * @returns The parsed do-while statement node.
     */
    private parseDoWhileStatement(): StatementNode {
        this.consume({ type: "Identifier", value: "do" }, "Expected 'do' keyword");

        const bodyExpression = this.parseBlockExpression();
        const body = {
            type: "Block",
            body: bodyExpression,
            loc: {
                start: bodyExpression[0]?.loc.start || this.previous()?.start || { line: -1, column: -1 },
                end: bodyExpression[bodyExpression.length - 1]?.loc.end || this.previous()?.end || { line: -1, column: -1 }
            }
        } satisfies BlockNode;

        this.consume({ type: "Identifier", value: "while" }, "Expected 'while' after do block");
        this.consume({ type: "(" }, "Expected '(' after 'while'");
        const condition = this.parseExpression();
        this.consume({ type: ")" }, "Expected ')' after do-while condition");
        this.tryConsume("type", [";"]);

        return {
            type: "DoWhileStatement",
            condition,
            body,
            loc: {
                start: body.loc.start,
                end: this.previous()?.end || condition.loc.end
            }
        };
    }

    private parseSwitchStatement(): StatementNode {
        const start = this.peek()!.start;
        this.consume({ type: "Identifier", value: "switch" }, "Expected 'switch' keyword");
        this.consume({ type: "(" }, "Expected '(' after 'switch'");
        const value = this.parseExpression();
        this.consume({ type: ")" }, "Expected ')' after the 'switch'-value");

        this.consume({ type: "{" }, "Expected '{' after switch expression");
        const body: (CaseDeclarationNode | DefaultCaseDeclarationNode)[] = [];

        while (!this.isAtEnd() && !this.checkToken("type", ["}"])) {
            const stmt = this.parseStatement();
            if (stmt?.type === "CaseDeclaration" || stmt?.type === "DefaultCaseDeclaration") {
                body.push(stmt as CaseDeclarationNode | DefaultCaseDeclarationNode);
            }
        }

        this.consume({ type: "}" }, "Expected '}' to close switch block");

        return {
            type: "SwitchDeclaration",
            value,
            body,
            loc: { start, end: this.previous()?.end || value.loc.end }
        };
    }

    private parseCaseStatement(): StatementNode {
        const start = this.peek()!.start;
        this.consume({ type: "Identifier", value: "case" }, "Expected 'case' keyword");
        this.consume({ type: "(" }, "Expected '(' after 'case'");
        const values: ExpressionNode[] = [this.parseExpression()];
        while (this.tryConsume("type", [","])) {
            values.push(this.parseExpression());
        }
        this.consume({ type: ")" }, "Expected ')' after case values");

        const stmts = this.parseBlockExpression();
        const body: BlockNode = {
            type: "Block",
            body: stmts,
            loc: { start: stmts[0]?.loc.start || start, end: stmts[stmts.length - 1]?.loc.end || start }
        };
        return { type: "CaseDeclaration", values, body, loc: { start, end: body.loc.end } };
    }

    private parseDefaultCaseStatement(): StatementNode {
        const start = this.peek()!.start;
        this.consume({ type: "Identifier", value: "default" }, "Expected 'default' keyword");

        const stmts = this.parseBlockExpression();
        const body: BlockNode = {
            type: "Block",
            body: stmts,
            loc: { start: stmts[0]?.loc.start || start, end: stmts[stmts.length - 1]?.loc.end || start }
        };
        return { type: "DefaultCaseDeclaration", body, loc: { start, end: body.loc.end } };
    }

    /**
     * Parses an if/elif/else statement from the token list.
     * @returns The parsed if statement node.
     */
    private parseIfStatement(): StatementNode {
        this.consume({ type: "Identifier", value: "if" }, "Expected 'if' keyword");
        this.consume({ type: "(" }, "Expected '(' after 'if'");
        const condition = this.parseExpression();
        this.consume({ type: ")" }, "Expected ')' after the 'if'-condition");
        const thenBlockExpression = this.parseBlockExpression();
        const thenBlock = {
            type: "Block",
            body: thenBlockExpression,
            loc: {
                start: thenBlockExpression[0]?.loc.start || condition.loc.end,
                end: thenBlockExpression[thenBlockExpression.length - 1]?.loc.end || condition.loc.end
            }
        } satisfies BlockNode;
        
        const elifs: ElifClauseNode[] = [];
        while (this.tryConsume("value", ["elif"])) {
            this.consume({ type: "(" }, "Expected '(' after 'elif'");
            const elifCondition = this.parseExpression();
            this.consume({ type: ")" }, "Expected ')' after elif condition");
            const elifBlock = this.parseBlockExpression();
            elifs.push({
                type: "ElifClause",
                condition: elifCondition,
                block: {
                    type: "Block",
                    body: elifBlock,
                    loc: {
                        start: elifBlock[0]?.loc.start || elifCondition.loc.start,
                        end: elifBlock[elifBlock.length - 1]?.loc.end || elifCondition.loc.end
                    }
                },
                loc: {
                    start: elifCondition.loc.start,
                    end: elifBlock[elifBlock.length - 1]?.loc.end || elifCondition.loc.end
                }
            });
        }

        let elseBlock  = null;
        if (this.tryConsume("value", ["else"])) {
            const elseBlockExpression = this.parseBlockExpression();
            elseBlock = {
                type: "Block",
                body: elseBlockExpression,
                loc: {
                    start: elseBlockExpression[0]?.loc.start || this.peek()?.start || condition.loc.end,
                    end: elseBlockExpression[elseBlockExpression.length - 1]?.loc.end || this.peek()?.end || condition.loc.end
                }
            } satisfies BlockNode;
        }

        return {
            type: "IfStatement",
            condition,
            thenBlock,
            elifs,
            elseBlock,
            loc: {
                start: condition.loc.start,
                end: elseBlock ? elseBlock.loc.end : thenBlock.loc.end
            }
        };
    }

    /**
     * Parses an expression from the token list.
     * @returns The parsed expression node.
     */
    private parseExpression(minBP = 0): ExpressionNode {
        this.logger.log(new KatnipLog(KatnipLogType.Debug, `PREfix operator: ${this.peek()?.token.type}`));
        let left = this.parsePrefix();

        while (true) {
            const token = this.peek();
            if (!token) break;

            const bp = getBindingPower(token);
            if (!bp || bp.lbp <= minBP) break;

            //this.advance();
            this.logger.log(new KatnipLog(KatnipLogType.Debug, `Infix operator: ${this.peek()?.token.type}`));
            left = this.parseInfix(left, bp);
        }

        this.logger.log(new KatnipLog(KatnipLogType.Debug, `QUIT on: ${this.peek()?.token.type}`));

        return left;
    }

    /**
     * Checks whether a token can begin an expression.
     * @param token - The token to evaluate.
     * @returns True when the token can start an expression, otherwise false.
     */
    private canStartExpression(token: Token | null): boolean {
        if (!token) return false;
        const type = token.token.type;
        return (
            type === "Identifier" ||
            type === "Number" ||
            type === "String" ||
            type === "InterpolatedString" ||
            type === "(" ||
            type === "[" ||
            type === "{" ||
            type === "!" ||
            type === "-"
        );
    }

    /**
     * Parses an interpolated string expression.
     * @returns The parsed interpolated string expression node.
     */
    private parseInterpolatedString(): ExpressionNode {
        const startToken = this.consume({ type: "InterpolatedString" }, "Expected interpolated string literal");
        const parts: (string | ExpressionNode)[] = [];
        parts.push(startToken.token.value);

        let end = startToken.end;

        while (this.canStartExpression(this.peek())) {
            const expr = this.parseExpression();
            parts.push(expr);
            end = expr.loc.end;

            if (!this.checkToken("type", ["InterpolatedStringEnd"])) {
                this.reporter.add(
                    new KatnipError(
                        "Parser",
                        "Expected end of interpolated expression '}'",
                        this.peek()?.start ?? expr.loc.end
                    )
                );
                break;
            }

            const endToken = this.consume({ type: "InterpolatedStringEnd" }, "Expected end of interpolated expression '}'");
            end = endToken.end;

            if (!this.checkToken("type", ["InterpolatedString"])) {
                break;
            }

            const nextChunk = this.consume({ type: "InterpolatedString" }, "Expected interpolated string chunk");
            parts.push(nextChunk.token.value);
            end = nextChunk.end;
        }

        return {
            type: "InterpolatedString",
            parts,
            loc: { start: startToken.start, end }
        } as ExpressionNode;
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
        if (value === "!" || value === "-") {
            this.advance();
            const opKey = value === "-" ? "UnaryMinus" : value;
            const { rbp } = bindingPowerTable[opKey];
            const right = this.parseExpression(rbp);
            return {
                type: "UnaryExpression",
                operator: value as UnaryOperator,
                argument: right,
                loc: { start: token.start, end: right.loc?.end || token.end },
            } as ExpressionNode;
        }

        // Parenthesized expression
        if (this.tryConsume("type", ["("])) {
            if (this.checkToken("type", [")"])) {
                this.advance();
                return { type: "EmptyExpression", loc: { start: token.start, end: this.previous()!.end } }
            }

            const expr = this.parseExpression();

            if (this.checkToken("type", [","])) {
                let tupleElements: ExpressionNode[] = [expr];
                while (this.tryConsume("type", [","])) {
                    tupleElements.push(this.parseExpression());
                }
                this.consume({ type: ")" }, "Expected ')' after parenthesized expression");
                return {
                    type: "TupleExpression",
                    elements: tupleElements,
                    loc: { start: token.start, end: this.previous()!.end }
                };
            }
            
            this.consume({ type: ")" }, "Expected ')' after parenthesized expression");
            return expr;
        }

        // Bracket expression
        if (this.tryConsume("type", ["["])) {
            const listContents: ExpressionNode[] = [];
            if (!this.checkToken("type", ["]"])) {
                do {
                    listContents.push(this.parseExpression());
                    this.tryConsume("type", [","]);
                } while (!this.isAtEnd() && !this.checkToken("type", ["]"]));
            }

            this.consume({ type: "]" }, "Expected ']' after list expression");
            return {
                type: "ListExpression",
                elements: listContents,
                loc: { start: token.start, end: this.previous()!.end }
            };
        }

        // Dictionary expression
        if (this.tryConsume("type", ["{"])) {
            const curlyArgs: DictEntryNode[] = [];
            if (!this.checkToken("type", ["}"])) {
                do {
                    const keyToken = this.consume({ type: ["String", "Number", "Identifier"] }, "Expected string or number literal or identifier as dictionary key").token;
                    this.consume({ type: ":" }, "Expected ':' after dictionary key" );
                    const value = this.parseExpression();

                    let type: "String" | "Number" | "Null" = "Null";
                    if (
                        keyToken.type === "String" ||
                        keyToken.type === "Identifier"
                    ) {
                        type = "String";
                    } else if (keyToken.type === "Number") {
                        type = "Number";
                    }

                    curlyArgs.push({ key: { type: "Literal", value: keyToken.value, valueType: type, loc: { start: token.start, end: token.end } }, value });
                } while (this.tryConsume("type", [","]));
            }
            this.consume({ type: "}" }, "Expected '}' after parameters");

            return {
                type: "DictExpression",
                entries: curlyArgs,
                loc: {
                    start: token.start,
                    end: this.previous()!.end,
                },
            };
        }

        // Identifiers
        if (this.checkToken("type", ["Identifier"])) {
            const id = this.consume({ type: "Identifier" }, "Expected identifier");
            if (id.token.value === "true" || id.token.value === "false") {
                return {
                    type: "Literal",
                    value: id.token.value === "true",
                    valueType: "Boolean",
                    loc: { start: id.start, end: id.end },
                } as ExpressionNode;
            }
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
                valueType: "String",
                loc: { start: lit.start, end: lit.end },
            } as ExpressionNode;
        }

        if (this.checkToken("type", ["InterpolatedString"])) {
            return this.parseInterpolatedString();
        }

        // Number literal
        if (this.checkToken("type", ["Number"])) {
            const lit = this.consume({ type: "Number" }, "Expected number literal");
            return {
                type: "Literal",
                value: Number(lit.token.value),
                valueType: "Number",
                loc: { start: lit.start, end: lit.end },
            } as ExpressionNode;
        }

        // EOF
        if (this.checkToken("type", ["<EOF>"])) {
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
     * Parses a single call argument: either a positional expression or a named argument of the form `name = value`.
     * @returns The parsed argument node.
     */
    private parseArgument(): ExpressionNode | NamedArgumentNode {
        if (
            this.checkToken("type", ["Identifier"]) &&
            this.peek(1)?.token.type === "="
        ) {
            const nameToken = this.consume({ type: "Identifier" }, "Expected argument name");
            this.consume({ type: "=" }, "Expected '=' after argument name");
            const value = this.parseExpression();
            return {
                type: "NamedArgument",
                name: nameToken.token.value,
                value,
                loc: { start: nameToken.start, end: value.loc.end }
            };
        }

        return this.parseExpression();
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

        if (this.checkToken("type", ["("])) {
            this.advance();
            const parenArgs: (ExpressionNode | NamedArgumentNode)[] = [];
            if (!this.checkToken("type", [")"])) {
                do {
                    parenArgs.push(this.parseArgument());
                } while (this.tryConsume("type", [","]));
            }
            this.consume({ type: ")" }, "Expected ')' after arguments");

            return {
                type: "CallExpression",
                object: left,
                arguments: parenArgs,
                loc: {
                    start: left.loc.start,
                    end: this.previous()?.end || token.end,
                },
            };
        }
    
        if (this.checkToken("type", ["["])) {
            this.advance();

            // Optional start: absent when the bracket opens straight onto ':' or ']'.
            let sliceStart: ExpressionNode | null = null;
            if (!this.checkToken("type", [":", "]"])) {
                sliceStart = this.parseExpression();
            }

            // No ':' => plain index access (arr[expr]), which needs an index.
            if (!this.checkToken("type", [":"])) {
                if (!sliceStart) {
                    this.reporter.add(
                        new KatnipError("Parser", "Expected an index or slice inside '[]'", this.peek()?.start || { line: -1, column: -1 })
                    );
                }
                this.consume({ type: "]" }, "Expected ']' after index");
                return {
                    type: "IndexerAccess",
                    object: left,
                    index: sliceStart ?? { type: "ErrorToken", value: "", loc: { start: left.loc.start, end: left.loc.end } } as ExpressionNode,
                    loc: {
                        start: left.loc.start,
                        end: this.previous()?.end || token.end,
                    },
                };
            }

            // Slice: consume the first ':', then an optional end and optional ':' + step.
            this.advance(); // consume ':'
            let sliceEnd: ExpressionNode | null = null;
            if (!this.checkToken("type", [":", "]"])) {
                sliceEnd = this.parseExpression();
            }
            let sliceStep: ExpressionNode | null = null;
            if (this.tryConsume("type", [":"])) {
                if (!this.checkToken("type", ["]"])) {
                    sliceStep = this.parseExpression();
                }
            }
            this.consume({ type: "]" }, "Expected ']' after slice");

            return {
                type: "SliceAccess",
                object: left,
                start: sliceStart,
                end: sliceEnd,
                step: sliceStep,
                loc: {
                    start: left.loc.start,
                    end: this.previous()?.end || token.end,
                },
            };
        }

        if (this.checkToken("type", ["."])) {
            // Member access
            if (this.checkToken("type", ["."])) {
              this.advance();
              const id = this.consume(
                { type: "Identifier" },
                "Expected property name after '.'",
              );
              return {
                type: "MemberExpression",
                object: left,
                property: {
                  type: "Identifier",
                  name: id.token.value,
                  loc: { start: id.start, end: id.end },
                },
                loc: { start: left.loc.start, end: id.end },
              } as ExpressionNode;
            }
        }

        // Binary operator (fallback). Use binding power to parse right-hand side.
        const tokenValue = isValuedTokenType(token.token.type)
            ? (token.token as ValuedToken).value
            : token.token.type;
        
        this.advance();
        const right = this.parseExpression(bp.rbp);
        return {
            type: "BinaryExpression",
            operator: tokenValue as BinaryOperator,
            left,
            right,
            loc: { start: left.loc.start, end: right.loc.end },
        } as ExpressionNode;
    }

    /**
     * Parses a block expression following a method call.
     * @param allowedStatements - A list of allowed statement types inside this body.
     * @returns The parsed block expression node.
     */
    private parseBlockExpression(allowedStatements?: StatementNode[]): StatementNode[] {
        if (!this.checkToken("type", ["{"])) {
            this.reporter.add(new KatnipError(
                "Parser",
                "Expected '{' to open block",
                this.peek()?.start ?? this.previous()?.end ?? { line: -1, column: -1 },
            ));
            while (!this.isAtEnd() && !this.checkToken("type", ["{", "}"])) this.advance();
        }
        this.tryConsume("type", ["{"]);
        const body: StatementNode[] = [];

        while (!this.isAtEnd() && !this.checkToken("type", ["}"])) {
            const stmt = this.parseStatement();
            if (stmt && (!allowedStatements || allowedStatements.includes(stmt))) {
                body.push(stmt);
            }
        }

        this.consume({ type: "}" }, "Expected '}' to close block");

        return body;
    }
}
