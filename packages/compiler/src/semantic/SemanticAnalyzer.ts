/**
 * @fileoverview Contains the semantic analysis logic for the Katnip compiler, including type checking and symbol resolution.
 */

import { ErrorReporter, KatnipError } from "../utils/ErrorReporter.js";
import { KatnipLog, KatnipLogType, Logger } from "../utils/Logger.js";
import type {
    AST,
    BlockNode,
    EnumDeclarationNode,
    NodeBase,
    ProcedureDeclarationNode,
    SpriteDeclarationNode,
    StatementNode,
    ExpressionStatementNode,
    ExpressionNode,
    VariableDeclarationNode,
} from "../parser/AST-nodes.js";
import { Scope, type ScopeKind, type SymbolEntry } from "./SymbolTable.js";

export class SemanticAnalyzer {
    /** Current lexical scope. Changed by exit() and enter() */
    private current: Scope;

    constructor(
        private reporter: ErrorReporter,
        private logger: Logger = new Logger(),
    ) {
        this.current = new Scope("global");
    }

    /**
     * Runs semantic analysis over a parsed AST.
     * Pass 1 hoists top-level declarations (so forward references resolve);
     * Pass 2 walks the tree resolving identifiers and enforcing scope rules.
     * @returns The global scope, for downstream passes (IR/codegen).
     */
    analyze(ast: AST): Scope {
        this.logger.print(
            new KatnipLog(
                KatnipLogType.Info,
                `--- Semantic analysis started with ${ast.body.length} top-level statements ---`,
            ),
        );

        this.hoist(ast.body);
        for (const stmt of ast.body) this.visit(stmt);

        return this.current;
    }

    // -- Scope stack --

    /** Pushes a fresh child scope and makes it current. */
    private enter(kind: ScopeKind): void {
        this.current = new Scope(kind, this.current);
    }

    /** Pops back to the parent scope. */
    private exit(): void {
        if (this.current.parent) this.current = this.current.parent;
    }

    /** Whether the current scope is inside a procedure body (where `return` is valid). */
    private inProcedure(): boolean {
        for (let scope: Scope | null = this.current; scope; scope = scope.parent) {
            if (scope.kind === "procedure") return true;
        }
        return false;
    }

    /** Declares a symbol in the current scope, reporting on illegal redeclaration. */
    private declare(sym: SymbolEntry, node: NodeBase): void {
        const conflict = this.current.declare(sym);
        if (conflict)
            this.error(`'${sym.name}' is already declared in this scope`, node);
    }

    // -- Pass 1: hoist top-level declarations --

    /**
     * Declares procedures, enums, sprites, and top-level variables from a statement list into the current scope before bodies are walked.
     * This is so that they can be referenced early. Top-level variables are the file's shared namespace, visible to every sprite regardless of declaration order.
     */
    private hoist(body: StatementNode[]): void {
        for (const stmt of body) {
            switch (stmt.type) {
                case "ProcedureDeclaration":
                    this.hoistProcedure(stmt);
                    break;
                case "EnumDeclaration":
                    this.hoistEnum(stmt);
                    break;
                case "SpriteDeclaration":
                    this.hoistSprite(stmt);
                    break;
                case "VariableDeclaration":
                    this.hoistVariable(stmt);
                    break;
            }
        }
    }

    private hoistProcedure(node: ProcedureDeclarationNode): void {
        this.declare(
            {
                kind: "procedure",
                name: node.name,
                declNode: node,
                signatures: [{ params: node.parameters, returnType: node.returnType }],
            },
            node,
        );
    }

    private hoistEnum(node: EnumDeclarationNode): void {
        this.declare(
            { kind: "enum", name: node.name, declNode: node, members: node.members },
            node,
        );
    }

    private hoistSprite(node: SpriteDeclarationNode): void {
        this.declare({ kind: "sprite", name: node.name, declNode: node }, node);
    }

    private hoistVariable(node: VariableDeclarationNode): void {
        this.declare(
            {
                kind: "variable",
                name: node.name,
                declNode: node,
                type: node.varType,
                access: node.access,
            },
            node,
        );
    }

    // -- Pass 2: resolve --

    /** Dispatches a statement to its handler. */
    private visit(node: StatementNode): void {
        switch (node.type) {
            case "VariableDeclaration":
                // `private` at the top scope is valid: the variable is visible to
                // sprites in this file but cannot be imported into other files.
                if (node.initializer) this.resolveExpression(node.initializer);
                // Top-level variables are hoisted in Pass 1; only declare locals here.
                if (this.current.kind !== "global") {
                    this.declare(
                        {
                            kind: "variable",
                            name: node.name,
                            declNode: node,
                            type: node.varType,
                            access: node.access,
                        },
                        node,
                    );
                }
                break;
            case "VariableAssignment":
                this.resolveExpression(node.left);
                this.resolveExpression(node.right);
                break;
            case "ProcedureDeclaration":
                if (node.access === "temp") {
                    this.error("Procedures cannot be declared 'temp'", node, node.access.length);
                }
                this.enter("procedure");
                for (const param of node.parameters) {
                    this.declare(
                        {
                            kind: "parameter",
                            name: param.name,
                            declNode: param,
                            type: param.paramType,
                        },
                        param,
                    );
                }
                for (const stmt of node.body.body) this.visit(stmt);
                this.exit();
                break;
            case "SpriteDeclaration":
                this.visitBlock(node.body, "sprite");
                break;
            case "HandlerStatement":
                // TODO: validate hat block
                if (this.current.kind !== "sprite") {
                    this.error(
                        "Event handlers can only appear at the top level of a sprite",
                        node.call,
                    )
                }
                this.resolveExpression(node.call);
                this.visitBlock(node.body);
                break;
            case "IfStatement":
                this.resolveExpression(node.condition);
                this.visitBlock(node.thenBlock);
                for (const elifBlock of node.elifs) {
                    this.resolveExpression(elifBlock.condition)
                    this.visitBlock(elifBlock.block)
                }
                if (node.elseBlock) this.visitBlock(node.elseBlock)
                break;
            case "WhileStatement":
            case "DoWhileStatement":
                this.resolveExpression(node.condition);
                this.visitBlock(node.body);
                break;
            case "ForStatement":
                // TODO: check tuple matches iterable's elment shape
                this.resolveExpression(node.iterable)

                this.enter("block");
                const loopVars = node.pattern.type === "TupleExpression"
                    ? node.pattern.elements
                    : [node.pattern];
                for (const loopVar of loopVars) {
                    if (loopVar.type !== "Identifier") {
                        this.error(
                            "Loop variable must be an identifier",
                            loopVar,
                        );
                        continue;
                    }
                    this.declare(
                        {
                            kind: "loopVar",
                            name: loopVar.name,
                            declNode: loopVar,
                            type: null, // TODO: inference fill in later
                        },
                        loopVar,
                    );
                }
                for (const stmt of node.body.body) this.visit(stmt);
                this.exit();
                break;
            case "ExpressionStatement":
                this.resolveExpression(node.expression);
                break;
            case "ReturnStatement":
                if (node.argument) this.resolveExpression(node.argument);
                if (!this.inProcedure()) {
                    this.error(
                        "'return' can only be used inside a procedure",
                        node,
                        "return".length,
                    );
                }
                break;
            case "SwitchDeclaration": 
                {
                    // TODO: Check for all cases covered or default case for enum; falthrough kward not in default and used correctly
                    const defaultCases = node.body.filter(
                    (caseEntry) => caseEntry.type === "DefaultCaseDeclaration",
                    );
                    if (defaultCases.length > 1) {
                        this.error(
                            `2 or more 'default' cases found in switch-case statement`,
                            defaultCases[1],
                            "default".length,
                        );
                    }
                    if (
                        node.body.length > 0 
                        && defaultCases.length === 1
                        && node.body.at(-1)?.type !== "DefaultCaseDeclaration"
                    ) {
                        this.error(
                            `'default' case not located at bottom of switch-case statement`,
                            defaultCases[0],
                            "default".length,
                        );
                    }

                    this.resolveExpression(node.value);
                    for (const caseEntry of node.body) this.visit(caseEntry);
                    break;
                }
            case "CaseDeclaration":
                for (const caseExpr of node.values) this.resolveExpression(caseExpr);
                this.visitBlock(node.body);
                break;
            case "DefaultCaseDeclaration":
                this.visitBlock(node.body);
                break;
            case "EnumDeclaration":
                // Enum body already hoisted; just validate the modifier.
                if (node.access === "temp") {
                    this.error("Enums cannot be declared 'temp'", node, node.access.length);
                }
                break;
            case "ErrorStatement":
                // Error statements come from the parser.
                break;
        }
    }

    /** Three-step reusable block visitor. */
    private visitBlock(block: BlockNode, kind: ScopeKind = "block"): void {
        this.enter(kind);
        for (const statement of block.body) this.visit(statement);
        this.exit();
    }

    private resolveExpression(expression: ExpressionNode): void {
        switch (expression.type) {
          case "Identifier":
            if (!this.current.lookup(expression.name)) {
              this.error(`'${expression.name}' is not defined`, expression);
            }
            break;
          case "BinaryExpression":
            this.resolveExpression(expression.left);
            this.resolveExpression(expression.right);
            break;
          case "CallExpression":
            this.resolveExpression(expression.object);
            for (const arg of expression.arguments) {
              this.resolveExpression(
                arg.type === "NamedArgument" ? arg.value : arg,
              );
            }
            break;
          case "DictExpression":
            for (const entry of expression.entries) {
                this.resolveExpression(entry.key);
                this.resolveExpression(entry.value);
            }
            break;
          case "EmptyExpression":
            break;
          case "ErrorToken":
            break;
          case "IndexerAccess":
            this.resolveExpression(expression.object);
            this.resolveExpression(expression.index);
            break;
          case "InterpolatedString":
            for (const entry of expression.parts) {
                if (!(typeof entry === "string")) {
                    this.resolveExpression(entry)
                }
            }
            break;
          case "ListExpression":
            for (const item of expression.elements) {
                this.resolveExpression(item)
            }
            break;
          case "Literal":
            break;
          case "MemberExpression":
            // TODO: resolve namespaces (motion.*, op.*), enum members (directions.UP), and sprite members (self.x). The property is never a free variable, so it must NOT be resolved as one here.
            break;
          case "SliceAccess":
            this.resolveExpression(expression.object);
            this.resolveExpression(expression.start);
            if (expression.step) this.resolveExpression(expression.step);
            this.resolveExpression(expression.end);
            break;
          case "TupleExpression":
            for (const item of expression.elements) {
              this.resolveExpression(item);
            }
            break;
          case "UnaryExpression":
            this.resolveExpression(expression.argument);
            break;
        }
    }

    // -- Helpers --

    /**
     * Reports a semantic error at a node's start location.
     * By default the caret spans the whole node; pass `length` to underline only
     * the first N columns (e.g. just an offending keyword).
     */
    private error(message: string, node: NodeBase, length?: number): void {
        this.reporter.add(
            new KatnipError("Semantic", message, {
                line: node.loc.start.line,
                column: node.loc.start.column,
                ...(length != null
                    ? { length }
                    : { endLine: node.loc.end.line, endColumn: node.loc.end.column }),
            }),
        );
    }
}
