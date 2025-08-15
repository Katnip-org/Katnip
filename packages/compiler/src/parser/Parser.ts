/**
 * @fileoverview Contains the main parser class for the Katnip compiler.
 */

import { isValuedTokenType, Token, ValuedToken } from "../lexer/Token";
import { ErrorReporter, KatnipError } from "../utils/ErrorReporter";
import { Logger } from "../utils/Logger";
import { AST, NodeBase } from "./AST-nodes";

export class Parser {
    private tokens: Token[] = [];
    private position = 0;

    constructor(
        private reporter: ErrorReporter,
        private logger: Logger = new Logger(),
    ) {}

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
    private peek(): Token | null {
        return this.position < this.tokens.length ? this.tokens[this.position] : null;
    }

    private previous(): Token | null {
        return this.position > 0 ? this.tokens[this.position - 1] : null;
    }

    private advance(): Token | null {
        if (!this.isAtEnd()) {
            this.position++;
        }
        return this.previous();
    }

    private isAtEnd(): boolean {
        return this.peek()?.token.type === "EOF";
    }

    private check(type: string): boolean {
        return !this.isAtEnd() && this.peek()?.token.type === type;
    }

    private checkValue(value: string): boolean {
        const nextToken: Token | null = this.peek();
        if (nextToken && isValuedTokenType(nextToken.token.type)) {
            const nextTokenContent = nextToken.token as ValuedToken;
            return !this.isAtEnd() && nextTokenContent.value === value;
        } else return false;
    }

    private match(...types: string[]): boolean {
        for (const type of types) {
            if (this.check(type)) {
                this.advance();
                return true;
            }
        }
        return false;
    }

    private matchValue(...values: string[]): boolean {
        for (const value of values) {
            if (this.checkValue(value)) {
                this.advance();
                return true;
            }
        }
        return false;
    }

    private consume(
        options: { type?: string | string[]; value?: string | string[] },
        message: string
    ): Token | void {
        const { type, value } = options;

        const checkType = (t: string) => this.check(t);
        const checkValue = (v: string) => this.checkValue(v);

        if (type) {
            if (Array.isArray(type) ? type.some(checkType) : checkType(type)) {
                return this.advance()!;
            }
        }

        if (value) {
            if (Array.isArray(value) ? value.some(checkValue) : checkValue(value)) {
                return this.advance()!;
            }
        }

        if (!type && !value) {
            throw new Error("consume() must be called with either type or value");
        }

        const token = this.peek();
        if (!token) {
            const lastToken = this.previous();
            if (lastToken) {
                this.reporter.add(
                    new KatnipError("Parser", "Unexpected end of input", {
                        line: lastToken.start.line,
                        column: lastToken.start.column,
                    })
                );
            }
        } else {
            this.reporter.add(new KatnipError("Parser", message, token.start));
        }
        return;
    }

    // -- Statement parsing --
    private parseStatement(): any {
        if (this.check("ProcedureDeclaration")) {
            return this.parseProcedureDefinition();
        } else if (this.check("EnumDeclaration")) {
            return this.parseEnumDefinition();
        } else if (this.check("Identifier")) {
            if (this.matchValue("private", "temp", "public")) {
                return this.parseVariableDeclaration();
            } else {
                return this.parseExpression();
            }
        }

        this.reporter.add(
            new KatnipError("Parser", "Unexpected token", this.peek()?.start || { line: -1, column: -1 })
        );
        this.advance();
        return;
    }

    // -- Rule methods --
    private parseProcedureDefinition(): any {
        const startToken = this.consume({ value: "proc" }, "Expected 'proc' keyword");
        this.consume({ type: "colon" }, "Expected ':' after 'proc' keyword");
        const nameToken = this.consume({ type: "identifier" }, "Expected procedure name");

        let parsingDecorators: boolean = true;
        const decorators: Record<string, string | number> = {};
        const parameters: Record<string, string | number> = {};
        if (this.match("ParenOpen")) {
            while (!this.check("ParenClose")) {
                if (this.match("AtSymbol")) {
                    const decoratorNameToken = this.consume({ type: "identifier" }, "Expected decorator name");
                    if (decoratorNameToken) {
                        const innerDecoratorToken = decoratorNameToken.token as ValuedToken;
                        const decoratorName = innerDecoratorToken.value

                        let decoratorValue: string | number;
                        if (this.consume({ type: ["string", "number"] }, "Expected assignment for decorator")) {
                            const valueToken = this.consume({ type: ["string", "number"] }, "Expected decorator value of type string or number");
                            if (valueToken) {
                                const innerValueToken = valueToken.token as ValuedToken;
                                decoratorValue = innerValueToken.value

                                decorators[decoratorName] = decoratorValue;
                            }
                        }
                    }
                } else if (this.check("Identifier")) {
                    parsingDecorators = false;
                } else {
                    this.reporter.add(new KatnipError("Parser", "Expected decorator or parameter", this.peek()?.start || { line: -1, column: -1 }));
                    return;
                }

                parameters.push({ name: paramName.token.value, type: paramType ? paramType.value : null });
                if (!this.match("Comma") && !this.check("ParenClose")) {
                    this.reporter.add(new KatnipError("Parser", "Expected ',' or ')'", this.peek()?.start || { line: -1, column: -1 }));
                    return;
                }
            }
            this.consume({ type: "ParenClose" }, "Expected closing parenthesis for parameters");
        }

        let returnType: any = null;
        if (this.match("--")) { // Check for "-" then ">"
            returnType = this.consume({ type: "Identifier" }, "Expected return type");
            if (!returnType) return;
        }

        const body: NodeBase[] = [];
        while (!this.isAtEnd() && !this.check("ProcedureEnd")) {
            const stmt = this.parseStatement();
            if (stmt) body.push(stmt);
        }

        return {
            type: "ProcedureDeclaration",
            name: nameToken.value,
            decorators,
            parameters,
            returnType: returnType ? { type: "Type", typeName: returnType.value } : null,
            body
        };
    }

    private parseEnumDefinition(): any {
        // TODO: implement
    }

    private parseVariableDeclaration(): any {
        // TODO: implement
    }

    private parseExpression(): any {
        // TODO: implement
    }
}
