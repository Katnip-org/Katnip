/**
 * @fileoverview Contains the main parser class for the Katnip compiler.
 */

import { isValuedTokenType, Token, TokenInfoFor, TokenPos, TokenType, ValuedToken } from "../lexer/Token";
import { ErrorReporter, KatnipError } from "../utils/ErrorReporter";
import { Logger } from "../utils/Logger";
import { AST, DecoratorNode, NodeBase, ParameterNode, ProcedureDeclarationNode, SingleTypeNode, TypeNode, UnionTypeNode } from "./AST-nodes";

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
    private checkToken(kind: "type" | "value", ...patterns: string[]): boolean {
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
    private tryConsume(kind: "type" | "value", ...patterns: string[]): boolean {
        if (this.checkToken(kind, ...patterns)) {
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

        if (types.length && this.tryConsume("type", ...types)) {
            return this.previous() as { token: TokenInfoFor<T>; start: TokenPos; end: TokenPos };
        }
        if (values.length && this.tryConsume("value", ...values)) {
            return this.previous() as { token: TokenInfoFor<T>; start: TokenPos; end: TokenPos };
        }
        if (!types.length && !values.length) throw new Error("consume() must be called with either type or value");

        const token = this.peek();
        if (!token) {
            const lastToken = this.previous();
            if (lastToken) {
                this.reporter.add(
                    new KatnipError("Parser", "Unexpected end of input", lastToken.start)
                );
            }
        } else {
            this.reporter.add(new KatnipError("Parser", message, token.start));
        }

        return {
            token: { type: "ErrorToken", value: "" } as TokenInfoFor<T>,
            start: { line: -1, column: -1 },
            end: { line: -1, column: -1 }
        };
    }

    // -- Statement parsing --
    /** 
     * Parses through and returns a type annotation.
     * @returns The parsed type annotation
     */
    private parseTypeAnnotation(): SingleTypeNode | UnionTypeNode {
        const typeNameToken = this.consume({ type: "Identifier" }, "Expected type name");
        const typeName = typeNameToken.token.value;

        if (this.tryConsume("type", "Pipe")) {
            const rightType = this.parseTypeAnnotation();
            return {
                type: "UnionType",
                left: { type: "Type", typeName, loc: { start: typeNameToken.start, end: typeNameToken.end } },
                right: rightType,
                loc: { start: typeNameToken.start, end: rightType.loc.end }
            };
        } else if (this.tryConsume("type", "LeftChevron")) {
            const typeParams: TypeNode[] = [];
            while (!this.checkToken("type", "RightChevron")) {
                typeParams.push(this.parseTypeAnnotation());
                if (!this.tryConsume("type", "Comma") && !this.checkToken("type", "RightChevron")) {
                    this.reporter.add(
                        new KatnipError("Parser", "Expected ',' or '>'", this.peek()?.start || { line: -1, column: -1 })
                    );
                }
            }
            this.consume({ type: "RightChevron" }, "Expected closing '>' for type parameters");

            return {
                type: "Type",
                typeName,
                typeParams,
                loc: { start: typeNameToken.start, end: this.peek()?.end || { line: -1, column: -1 } }
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
    private parseStatement(): any {
        if (this.checkToken("type", "ProcedureDeclaration")) {
            return this.parseProcedureDefinition();
        } else if (this.checkToken("type", "EnumDeclaration")) {
            return this.parseEnumDefinition();
        } else if (this.checkToken("type", "Identifier")) {
            if (this.checkToken("value", "private", "temp", "public")) {
                return this.parseVariableDeclaration();
            } else {
                return this.parseExpression();
            }
        }

        this.reporter.add(
            new KatnipError("Parser", "Unexpected token", this.peek()?.start || { line: -1, column: -1 })
        );
        this.advance();
        return { type: "ErrorToken", value: "" };
    }

    /**
     * Parses a procedure definition from the token list.
     * @returns The parsed procedure declaration node.
     */
    private parseProcedureDefinition(): ProcedureDeclarationNode {
        this.consume({ type: "Identifier", value: "proc" }, "Expected 'proc' keyword");
        this.consume({ type: "Colon" }, "Expected ':' after 'proc' keyword");
        const nameToken = this.consume({ type: "Identifier" }, "Expected procedure name");
        const name = nameToken.token.value;

        let parsingDecorators = true;
        const decorators: DecoratorNode[] = [];
        const parameters: ParameterNode[] = [];

        if (this.tryConsume("type", "ParenOpen")) {
            while (!this.checkToken("type", "ParenClose")) {
                if (this.tryConsume("type", "AtSymbol") || this.checkToken("type", "Identifier")) {
                    if (this.checkToken("type", "Identifier")) parsingDecorators = false;
                } else {
                    this.reporter.add(
                        new KatnipError("Parser", "Expected decorator or parameter", this.peek()?.start || { line: -1, column: -1 })
                    );
                }

                if (parsingDecorators) {
                    const decoratorNameToken = this.consume({ type: "Identifier" }, "Expected decorator name");
                    const decoratorName = decoratorNameToken.token.value;

                    if (this.tryConsume("type", "Equals")) {
                        const decoratorValueToken = this.consume({ type: "Identifier" }, "Expected decorator value");
                        const decoratorValue = decoratorValueToken.token.value;

                        decorators.push({
                            type: "Decorator",
                            name: decoratorName,
                            value: decoratorValue,
                            loc: {
                                start: decoratorNameToken.start,
                                end: decoratorValueToken.end
                            }
                        });
                    }
                } else {
                    const argumentNameToken = this.consume({ type: "Identifier" }, "Expected argument name");
                    const argumentName = argumentNameToken.token.value;

                    if (this.tryConsume("type", "Colon")) {
                        const argumentTypeToken = this.consume({ type: "Identifier" }, "Expected argument type");
                        const argumentType = argumentTypeToken.token.value;

                        let defaultValueToken: Token | undefined = undefined;
                        let defaultValue: string | undefined = undefined;
                        if (this.tryConsume("type", "Equals")) {
                            defaultValueToken = this.consume({ type: "Identifier" }, "Expected default value");
                            const defaultValueInfo = defaultValueToken.token as ValuedToken;
                            defaultValue = defaultValueInfo.value;
                        }

                        parameters.push({
                            type: "Parameter",
                            name: argumentName,
                            paramType: {
                                type: "Type", typeName: argumentType,
                                loc: { start: argumentTypeToken.start, end: argumentTypeToken.end }
                            },
                            default: defaultValueToken ? {
                                type: "ParameterDefault",
                                value: defaultValue || "",
                                loc: { start: defaultValueToken.start, end: defaultValueToken.end}
                            } : undefined,
                            loc: {
                                start: argumentNameToken.start,
                                end: argumentTypeToken.end
                            }
                        });
                    }
                }

                if (!this.tryConsume("type", "Comma") && !this.checkToken("type", "ParenClose")) {
                    this.reporter.add(
                        new KatnipError("Parser", "Expected ',' or ')'", this.peek()?.start || { line: -1, column: -1 })
                    );
                }
            }
            this.consume({ type: "ParenClose" }, "Expected closing parenthesis for parameters");
        }

        this.consume({ type: "Minus" }, "Expected arrow return symbol piece '-'");
        this.consume({ type: "RightChevron" }, "Expected arrow return symbol piece '>' after '-'");

        const returnType = this.parseTypeAnnotation();

        this.consume({ type: "BraceOpen" }, "Expected open curly brace '{' for procedure body");

        const body: NodeBase[] = [];
        while (!this.isAtEnd() && !this.checkToken("type", "BraceClose")) {
            const stmt = this.parseStatement();
            if (stmt) body.push(stmt);
        }

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
    private parseEnumDefinition(): any {
        this.consume({ type: "Identifier", value: "enum" }, "Expected 'enum' keyword");
        this.consume({ type: "Colon" }, "Expected ':' after 'enum' keyword");
        const nameToken = this.consume({ type: "Identifier" }, "Expected enum name");
        const name = nameToken.token.value;

        if (this.tryConsume("type", "BraceOpen")) {
            const members: string[] = [];
            while (!this.checkToken("type", "BraceClose")) {
                const memberToken = this.consume({ type: "Identifier" }, "Expected enum member name");
                members.push(memberToken.token.value);

                if (!this.tryConsume("type", "Comma") && !this.checkToken("type", "ParenClose")) {
                    this.reporter.add(
                        new KatnipError("Parser", "Expected ',' or ')'", this.peek()?.start || { line: -1, column: -1 })
                    );
                }
            }
            this.consume({ type: "ParenClose" }, "Expected closing parenthesis for enum members");

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
    }

    /**
     * Parses a variable declaration from the token list.
     * @returns The parsed variable declaration node.
     */
    private parseVariableDeclaration(): any {
        const access = this.consume({ type: "Identifier", value: ["private", "temp", "public"] }, "Expected 'private', 'temp', or 'public' keyword");
        const variableName = this.consume({ type: "Identifier" }, "Expected variable name");
        this.consume({ type: "Colon" }, "Expected ':' after variable name for type annotation");
        const typeAnnotation = this.parseTypeAnnotation();
        this.consume({ type: "Equals" }, "Expected '=' after type annotation for variable declaration");
        // TODO: Handle variable initialization value, consuming list dict or any literal expression
    }

    /**
     * Parses an expression from the token list.
     * @returns The parsed expression node.
     */
    private parseExpression(): any {
        // TODO: implement
    }
}
