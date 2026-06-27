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

    /** Declares a symbol in the current scope, reporting on illegal redeclaration. */
    private declare(sym: SymbolEntry, node: NodeBase): void {
        const conflict = this.current.declare(sym);
        if (conflict)
            this.error(`'${sym.name}' is already declared in this scope`, node);
    }

    // -- Pass 1: hoist top-level declarations --

    /**
     * Declares procedures, enums, and sprites from a statement list into the
     * current scope before bodies are walked, so they can be referenced early.
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

    // -- Pass 2: resolve --

    /** Dispatches a statement to its handler. */
    private visit(node: StatementNode): void {
        switch (node.type) {
            case "VariableDeclaration":
                if (node.access === "private" && this.current.kind === "global") {
                    this.error(
                      `'${node.name}' cannot be made private when within a global scope`,
                      node,
                    );
                }

                if (node.initializer) this.resolveExpression(node.initializer);
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
                break;
            case "VariableAssignment":
                // TODO: resolve the assignment target + value expressions
                break;
            case "ProcedureDeclaration":
                // TODO: enter("procedure"), declare params, visit body, exit()
                break;
            case "SpriteDeclaration":
                // TODO: enter("sprite"), visit body, exit()
                break;
            case "HandlerStatement":
                // TODO: validate hat block, visit body block
                break;
            case "IfStatement":
                // TODO: resolve condition; visit then/elif/else blocks
                break;
            case "WhileStatement":
            case "DoWhileStatement":
                // TODO: resolve condition; visit body block
                break;
            case "ForStatement":
                // TODO: enter("block"), declare loopVar(s) from pattern, visit body, exit()
                break;
            case "ExpressionStatement":
                this.resolveExpression(node.expression);
                break;
            case "EnumDeclaration":
            case "ErrorStatement":
                // Enums already hoisted; error statements come from the parser.
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

    /** Reports a semantic error at a node's start location. */
    private error(message: string, node: NodeBase): void {
        this.reporter.add(
            new KatnipError("Semantic", message, {
                line: node.loc.start.line,
                column: node.loc.start.column,
            }),
        );
    }
}
