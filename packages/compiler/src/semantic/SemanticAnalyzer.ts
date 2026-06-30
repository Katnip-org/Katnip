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
    TypeNode,
} from "../parser/AST-nodes.js";
import { Scope, type ScopeKind, type SymbolEntry } from "./SymbolTable.js";
import { isAssignable, isStr, typeToString, type InternalType } from "./InternalTypes.js";

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
        for (
            let scope: Scope | null = this.current;
            scope;
            scope = scope.parent
        ) {
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
                if (node.initializer) this.inferType(node.initializer);
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
                this.inferType(node.left);
                this.inferType(node.right);
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
                    );
                }
                this.inferType(node.call);
                this.visitBlock(node.body);
                break;
            case "IfStatement":
                this.inferType(node.condition);
                this.visitBlock(node.thenBlock);
                for (const elifBlock of node.elifs) {
                    this.inferType(elifBlock.condition);
                    this.visitBlock(elifBlock.block);
                }
                if (node.elseBlock) this.visitBlock(node.elseBlock);
                break;
            case "WhileStatement":
            case "DoWhileStatement":
                this.inferType(node.condition);
                this.visitBlock(node.body);
                break;
            case "ForStatement":
                // TODO: check tuple matches iterable's elment shape
                this.inferType(node.iterable);

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
                this.inferType(node.expression);
                break;
            case "ReturnStatement":
                if (node.argument) this.inferType(node.argument);
                if (!this.inProcedure()) {
                    this.error(
                        "'return' can only be used inside a procedure",
                        node,
                        "return".length,
                    );
                }
                break;
            case "SwitchDeclaration": {
                // TODO: Check for all cases covered or default case for enum; falthrough kward not in default and used correctly
                const defaultCases = node.body.filter((caseEntry) => caseEntry.type === "DefaultCaseDeclaration");
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

                this.inferType(node.value);
                for (const caseEntry of node.body) this.visit(caseEntry);
                break;
            }
            case "CaseDeclaration":
                for (const caseExpr of node.values) this.inferType(caseExpr);
                this.visitBlock(node.body);
                break;
            case "DefaultCaseDeclaration":
                this.visitBlock(node.body);
                break;
            case "EnumDeclaration":
                // Enum body already hoisted; just validate the modifier.
                if (node.access === "temp") {
                    this.error(
                        "Enums cannot be declared 'temp'",
                        node,
                        node.access.length,
                    );
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

    /** Converts a written type annotation (TypeNode) into an InternalType. */
    private typeFromNode(node: TypeNode): InternalType {
        if (node.type === "UnionType") {
            return {
                kind: "union",
                left: this.typeFromNode(node.left),
                right: this.typeFromNode(node.right),
            };
        }

        // SingleTypeNode
        const params = node.typeParams ?? [];
        switch (node.typeName) {
            case "num":
            case "str":
            case "bool":
            case "void":
                return { kind: "primitive", name: node.typeName };
            case "list":
                return {
                    kind: "list",
                    element: params[0]
                        ? this.typeFromNode(params[0])
                        : { kind: "unknown" },
                };
            case "dict":
                return {
                    kind: "dict",
                    key: params[0]
                        ? this.typeFromNode(params[0])
                        : { kind: "unknown" },
                    value: params[1]
                        ? this.typeFromNode(params[1])
                        : { kind: "unknown" },
                };
            default: {
                // Any other stuff must resolve to an enum
                const symbols = this.current.lookup(node.typeName);
                if (symbols?.some((s) => s.kind === "enum")) {
                    return { kind: "enum", name: node.typeName };
                }
                this.error(`Unknown type '${node.typeName}'`, node);
                return { kind: "unknown" };
            }
        }
    }

    /**
     * Returns a symbol's resolved type, computing and caching it on first access
     * For inferred (un-annotated) variables, the analyzer is expected to have already written `cachedType` during inference
     */
    private typeOf(sym: SymbolEntry): InternalType {
        if (sym.cachedType) return sym.cachedType;

        let resolved: InternalType;
        switch (sym.kind) {
            case "variable":
            case "parameter":
            case "loopVar":
                resolved = sym.type
                    ? this.typeFromNode(sym.type)
                    : { kind: "unknown" };
                break;
            case "enum":
                resolved = { kind: "enum", name: sym.name };
                break;
            default:
                resolved = { kind: "unknown" }; // procedures/sprites aren't values
        }

        sym.cachedType = resolved;
        return resolved;
    }

    private inferType(expression: ExpressionNode): InternalType {
        switch (expression.type) {
            case "Identifier": {
                const sym = this.current.lookup(expression.name)?.[0];
                if (!sym) {
                    this.error(`'${expression.name}' is not defined`, expression);
                    return { kind: "unknown" };
                }
                return this.typeOf(sym);
            }
            case "BinaryExpression": {
                let l = this.inferType(expression.left);
                let r = this.inferType(expression.right);

                if (l.kind === "list" && r.kind === "list" && isAssignable(l, r)) return l;

                // `unknown` is the escape hatch (not-yet-typed calls/members);
                // let it pass so one missing type doesn't cascade into errors.
                if (
                    l.kind !== "unknown" &&
                    r.kind !== "unknown" &&
                    !(l.kind === "primitive" && r.kind === "primitive")
                ) {
                    this.error(
                        `Cannot use binop between two variables that are not both of primitive or list type`,
                        expression,
                    );
                }

                switch (expression.operator) {
                    // arithmetic
                    case "+":
                        return isStr(l) || isStr(r)
                            ? { kind: "primitive", name: "str" }
                            : { kind: "primitive", name: "num" };
                    case "-":
                    case "*":
                    case "/":
                    case "%":
                    case "**":
                        return { kind: "primitive", name: "num" };

                    // comparison
                    case "==":
                    case "<":
                    case ">":
                    case "<=":
                    case ">=":
                        return { kind: "primitive", name: "bool" };

                    // logical
                    case "&&":
                    case "||":
                    case "!&":
                    case "!|":
                    case "!^":
                    case "^":
                        return { kind: "primitive", name: "bool" };
                }
            }
            case "CallExpression":
                this.inferType(expression.object);
                for (const arg of expression.arguments) {
                    this.inferType(arg.type === "NamedArgument" ? arg.value : arg);
                }
                // TODO: resolve callee => procedureSymbol, pick overload, return this.typeFromNode(signiture.returnType ?? voidNode)
                return { kind: "unknown" };
            case "DictExpression": {
                if (expression.entries.length == 0)
                    return { kind: "dict", key: { kind: "unknown" }, value: { kind: "unknown" } };

                const firstKeyType = this.inferType(expression.entries[0].key);
                const firstValueType = this.inferType(expression.entries[0].value);

                for (const [i, entry] of expression.entries.entries()) {
                    const keyType = this.inferType(entry.key);
                    const valueType = this.inferType(entry.value);

                    if (!isAssignable(keyType, firstKeyType)) {
                        this.error(
                            `Expected key of type ${typeToString(firstKeyType)}, got ${typeToString(keyType)}`,
                            entry.key,
                        );
                        return {
                            kind: "dict",
                            key: { kind: "unknown" },
                            value: { kind: "unknown" },
                        };
                    }

                    if (!isAssignable(valueType, firstValueType)) {
                        this.error(
                            `Expected value of type ${typeToString(firstValueType)}, got ${typeToString(valueType)}`,
                            entry.value,
                        );
                        return {
                            kind: "dict",
                            key: { kind: "unknown" },
                            value: { kind: "unknown" },
                        };
                    }
                }

                return {
                    kind: "dict",
                    key: firstKeyType,
                    value: firstValueType,
                };
            }
            case "IndexerAccess": {
                const objectType = this.inferType(expression.object);
                this.inferType(expression.index);
                switch (objectType.kind) {
                    case "list":
                        return objectType.element;
                    case "dict":
                        return objectType.value;
                    case "tuple":
                        return objectType.elements[0]; // TODO: naive. Doesn't really work
                    case "primitive":
                        if (objectType.name === "str") return objectType;
                        break;
                    case "unknown":
                        return { kind: "unknown" };
                }
                this.error(
                    `Cannot index object of type ${typeToString(objectType)}`,
                    expression,
                );
                return { kind: "unknown" };
            }
            case "InterpolatedString":
                for (const entry of expression.parts) {
                    if (!(typeof entry === "string")) {
                        this.inferType(entry);
                    }
                }
                return { kind: "primitive", name: "str" };
            case "ListExpression": {
                if (expression.elements.length == 0) {
                    return { kind: "list", element: { kind: "unknown" } };
                }
                
                const types: InternalType[] = [];
                for (const element of expression.elements) {
                    const t = this.inferType(element);
                    const seen = types.some(
                        (existing) =>
                            isAssignable(existing, t) && isAssignable(t, existing),
                    );
                    if (!seen) types.push(t);
                }

                let element = types[0];
                for (let i = 1; i < types.length; i++) {
                    element = { kind: "union", left: element, right: types[i] };
                }

                return { kind: "list", element };
            }
            case "Literal":
                switch (expression.valueType) {
                    case "Number":
                        return { kind: "primitive", name: "num" };
                    case "String":
                        return { kind: "primitive", name: "str" };
                    case "Boolean":
                        return { kind: "primitive", name: "bool" };
                    case "Null":
                        return { kind: "unknown" };
                }
            case "MemberExpression":
                // TODO (Phase 3): resolve namespaces (motion.*, op.*), enum members (directions.UP), and sprite members (self.x). 
                // The property is never a free variable, so it must NOT be resolved as one here.
                return { kind: "unknown" };
            case "SliceAccess": {
                const objectType = this.inferType(expression.object);
                if (expression.start) this.inferType(expression.start);
                if (expression.end) this.inferType(expression.end);
                if (expression.step) this.inferType(expression.step);
                return objectType;
            }
            case "TupleExpression": {
                const elements = expression.elements.map(item => this.inferType(item));
                return { kind: "tuple", elements };
            }
            case "UnaryExpression":
                const right = this.inferType(expression.argument);
                switch (expression.operator) {
                    case "!":
                        if (!(right.kind === "primitive" && right.name === "bool")) {
                            this.error(`Must use '!' unop with a boolean expression type`, expression);
                        }
                        return { kind: "primitive", name: "bool" };

                    case "-":
                        if (!(right.kind === "primitive" && right.name === "num")) {
                            this.error(`Must use '-' unop with a numeric expression type`, expression);
                        }
                        return { kind: "primitive", name: "num" };
                }
            case "EmptyExpression":
                return { kind: "unknown" };
            case "ErrorToken":
                return { kind: "unknown" };
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
                    : {
                          endLine: node.loc.end.line,
                          endColumn: node.loc.end.column,
                      }),
            }),
        );
    }
}
