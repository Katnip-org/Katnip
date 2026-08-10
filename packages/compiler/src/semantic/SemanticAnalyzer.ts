/**
 * @fileoverview Contains the semantic analysis logic for the Katnip compiler, including type checking and symbol resolution.
 */

import { ErrorReporter, KatnipError } from "../utils/ErrorReporter.js";
import { KatnipLog, KatnipLogType, Logger } from "../utils/Logger.js";
import type {
    AST,
    BlockNode,
    DecoratorNode,
    EnumDeclarationNode,
    StructDeclarationNode,
    MemberExpressionNode,
    NodeBase,
    ProcedureDeclarationNode,
    SpriteDeclarationNode,
    StatementNode,
    ExpressionNode,
    VariableDeclarationNode,
    TypeNode,
    CallExpressionNode,
} from "../parser/AST-nodes.js";
import { isPublicVar } from "../parser/AST-nodes.js";
import {
    Scope,
    type LoweringKind,
    type ReturnMethod,
    type ScopeKind,
    type SymbolEntry,
    type ProcedureSymbol,
    type EnumSymbol,
    type StructSymbol,
    type NamespaceSymbol,
    type Signature,
    type SignatureMeta,
} from "./SymbolTable.js";
import { resolveReturnStrategies } from "./CallGraph.js";
import {
    bindReceiver,
    isAssignable,
    isStr,
    literalValue,
    substitute,
    typeToString,
    type AssignContext,
    type InternalType,
    type TypevarBindings,
} from "./InternalTypes.js";
import type { StdlibModule } from "./StdlibLoader.js";
import type { ImportedModule } from "./ModuleLoader.js";

/** A call argument after its type has been inferred, keeping the node for error locations. */
interface TypedArgument {
    type: InternalType;
    node: ExpressionNode;
}

/** A call's arguments, split into positional (by order) and named (by parameter name). */
interface CallArguments {
    positional: TypedArgument[];
    named: Map<string, TypedArgument>;
}

/** The result of resolving a call: its type plus the matched overload (for hat checks). */
interface ResolvedCall {
    type: InternalType;
    signature?: Signature;
}

/** How a member expression's object resolves, before the property is applied. */
type MemberHead =
    | { kind: "self" }
    | { kind: "namespace"; symbol: NamespaceSymbol; name: string }
    | { kind: "enum"; symbol: EnumSymbol; name: string }
    | { kind: "error" }
    | { kind: "value" }; // fall through to inferType(objNode)

/** Levenshtein distance, for dym suggestions. */
function editDistance(a: string, b: string): number {
    const row = [...Array(b.length + 1).keys()];
    for (let i = 1; i <= a.length; i++) {
        let diagonal = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const above = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = above;
        }
    }
    return row[b.length];
}

/** The member `value` was most likely a typo for, or null when nothing is close enough. */
function nearestMember(
    value: string | number | boolean,
    members: readonly (string | number)[],
): string | number | null {
    let best: string | number | null = null;
    let bestDistance = 3;
    for (const member of members) {
        const distance = editDistance(String(value), String(member));
        if (distance < bestDistance) [best, bestDistance] = [member, distance];
    }
    return best;
}

/** A placeholder declNode for symbols with no real source location (stdlib namespaces). */
function syntheticNode(type: string): NodeBase {
    return { type, loc: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } } };
}

export class SemanticAnalyzer {
    /** Current lexical scope. Changed by exit() and enter() */
    private current: Scope;

    /** Declared return type of the procedure being visited, or null at the top level. */
    private currentReturnType: InternalType | null = null;

    /** Type of the enclosing `switch` value, so `case` labels can be checked against it. */
    private currentSwitchType: InternalType | null = null;

    /** Keeps global scope clean- is the parent of the global scope */
    private readonly stdlibScope: Scope;

    /** True only while resolving stdlib signatures, where T/K/V typevars are legal. */
    private allowTypevars = false;

    /** True only while hoisting a stdlib module, whose enum values are real sb3 field strings. */
    private inStdlib = false;

    /** Which signature each call resolved to, for the call graph and IR lowering. */
    readonly callResolutions = new Map<CallExpressionNode, Signature>();

    /** User proc declarations to their signatures, for the call graph and IR lowering. */
    readonly procSignatures = new Map<ProcedureDeclarationNode, Signature>();

    /** Every expression's inferred type, for IR lowering. */
    readonly exprTypes = new Map<ExpressionNode, InternalType>();

    readonly constMembers = new Map<string, string | number | boolean>();

    /**
     * Member values of each enum, in declaration order, keyed by enum name (as `constMembers` is:
     * a name shared across namespaces collides, last declaration wins).
     * These are the *lowered* values — exactly what a member reference folds to — so a literal
     * coerced by `isAssignable` and the equivalent member reference emit identical IR.
     */
    private readonly enumValues = new Map<string, (string | number)[]>();

    constructor(
        private reporter: ErrorReporter,
        private logger: Logger = new Logger(),
    ) {
        this.stdlibScope = new Scope("stdlib");
        this.current = new Scope("global", this.stdlibScope);
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

        resolveReturnStrategies(this.procSignatures, this.callResolutions, (msg, node) =>
            this.error(msg, node),
        );

        return this.current;
    }

    // -- Stdlib loading --

    /**
     * Ingests pre-parsed stdlib modules before user analysis. 
     * Each file becomes a namespace named after its basename (motion.knip -> motion.*).
     */
    loadStdlib(modules: StdlibModule[]): void {
        for (const module of modules) {
            const savedReporter = this.reporter;
            const savedScope = this.current;
            this.reporter = module.reporter;
            this.allowTypevars = true;
            this.inStdlib = true;

            const isPrelude = module.namespace === "prelude";
            const target = isPrelude ? this.stdlibScope : new Scope("namespace", this.stdlibScope);
            this.current = target;
            this.hoist(module.ast.body);
            this.finalizeStdlibScope(module.ast.body);
            this.hoistNamespaceConsts(module.ast.body, isPrelude ? null : module.namespace);
            
            for (const stmt of module.ast.body)
                if (stmt.type === "ProcedureDeclaration" && this.procSignatures.get(stmt)?.meta?.lower === "builds")
                    this.visit(stmt);

            this.current = savedScope;
            this.allowTypevars = false;
            this.inStdlib = false;
            this.reporter = savedReporter;

            if (!isPrelude) {
                this.stdlibScope.declare({
                    kind: "namespace",
                    name: module.namespace,
                    declNode: syntheticNode("NamespaceDeclaration"),
                    scope: target,
                });
            }

            if (module.reporter.hasErrors()) {
                console.error(
                    `Internal compiler error in stdlib file '${module.sourcePath}' (this is a Katnip bug):`,
                );
                module.reporter.print();
                const [first] = module.reporter.getErrors();
                throw new KatnipError(
                    "Stdlib",
                    `stdlib module '${module.namespace}' failed to load${first ? `: ${first.message}` : ""}`,
                );
            }
        }
    }

    /**
     * Records a module's literal top-level variables as constant members ("math.pi").
     * IR lowering can fold `ns.const` without resolving scopes. 
     * A non-literal initializer is skipped: it needs blocks to build, and there is no namespace-level storage to build it into.
     */
    private hoistNamespaceConsts(body: StatementNode[], namespace: string | null): void {
        if (!namespace) return;
        for (const stmt of body)
            if (stmt.type === "VariableDeclaration" && stmt.initializer?.type === "Literal")
                this.constMembers.set(`${namespace}.${stmt.name}`, stmt.initializer.value ?? "");
    }

    // -- Import loading --

    /** Namespace scopes of already-analyzed modules, keyed by source path. */
    private readonly moduleScopes = new Map<string, Scope>();

    /**
     * Binds imported modules as namespaces in the current scope.
     * Call before analyze(); each module is analyzed once, however many files import it.
     */
    loadImports(modules: ImportedModule[]): void {
        for (const module of modules) {
            this.declare(
                {
                    kind: "namespace",
                    name: module.namespace,
                    declNode: module.importNode,
                    scope: this.moduleScope(module),
                },
                module.importNode,
            );
        }
    }

    /**
     * Analyzes an imported module in its own scope and returns the facade holding
     * only its public symbols. The module sees the stdlib and its own imports, never the importer's symbols.
     */
    private moduleScope(module: ImportedModule): Scope {
        const cached = this.moduleScopes.get(module.sourcePath);
        if (cached) return cached;

        const inner = new Scope("global", this.stdlibScope);
        const facade = new Scope("namespace", this.stdlibScope);
        this.moduleScopes.set(module.sourcePath, facade);

        const savedReporter = this.reporter;
        const savedScope = this.current;
        const savedReturnType = this.currentReturnType;
        this.reporter = module.reporter;
        this.current = inner;
        this.currentReturnType = null;

        this.loadImports(module.imports);
        this.hoist(module.ast.body);
        this.hoistNamespaceConsts(module.ast.body, module.namespace);
        for (const stmt of module.ast.body) this.visit(stmt);

        this.reporter = savedReporter;
        this.current = savedScope;
        this.currentReturnType = savedReturnType;

        // Only `public` declarations cross the file boundary. Imported modules cannot be re-exported
        for (const symbols of inner.entries().values())
            for (const sym of symbols)
                if ((sym.declNode as { access?: string }).access === "public") facade.declare(sym);

        // The imported file's own errors carry its line numbers, so they cannot be shown agaist this file. Surface first.
        const [first] = module.reporter.getErrors();
        if (first)
            this.error(
                `Imported file '${module.sourcePath}' has errors: ${first.message} (line ${first.location?.line ?? "?"})`,
                module.importNode,
            );

        return facade;
    }

    /** Resolve hoisted stdlib so they can be earglerly loaded. */
    private finalizeStdlibScope(body: StatementNode[]): void {
        for (const stmt of body) {
            if (stmt.type === "ProcedureDeclaration") {
                const procs = this.current
                    .lookupLocal(stmt.name)
                    ?.filter((s): s is ProcedureSymbol => s.kind === "procedure");
                const sig = procs
                    ?.flatMap((p) => p.signatures)
                    .find((s) => s.params === stmt.parameters);
                if (!sig) continue; // hoist already reported a redeclaration error
                sig.resolvedParamTypes = stmt.parameters.map((p) => this.typeFromNode(p.paramType));
                sig.resolvedReturn = stmt.returnType
                    ? this.typeFromNode(stmt.returnType)
                    : { kind: "primitive", name: "void" };
            } else if (stmt.type === "VariableDeclaration") {
                if (!stmt.varType) {
                    this.error(`Stdlib constant '${stmt.name}' must have a type annotation`, stmt);
                    continue;
                }
                const sym = this.current.lookupLocal(stmt.name)?.find((s) => s.declNode === stmt);
                if (sym) sym.cachedType = this.typeFromNode(stmt.varType);
            }
        }
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

    /** Whether the current scope is inside a sprite body (where `self` is valid). */
    private inSprite(): boolean {
        for (
            let scope: Scope | null = this.current;
            scope;
            scope = scope.parent
        ) {
            if (scope.kind === "sprite") return true;
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
            if (stmt.type === "EnumDeclaration") this.hoistEnum(stmt);
            else if (stmt.type === "StructDeclaration") this.hoistStruct(stmt);
        }
        for (const stmt of body) {
            switch (stmt.type) {
                case "ProcedureDeclaration":
                    this.hoistProcedure(stmt);
                    break;
                case "SpriteDeclaration":
                    this.hoistSprite(stmt);
                    for (const member of stmt.body.body) if (isPublicVar(member)) this.hoistVariable(member);
                    break;
                case "VariableDeclaration":
                    this.hoistVariable(stmt);
                    break;
            }
        }
    }

    private hoistProcedure(node: ProcedureDeclarationNode): void {
        const meta = this.extractMeta(node.decorators);
        meta.returns = this.deriveReturns(node.returnType);
        if (!meta.lower) {
            meta.lower = meta.opcode
                ? meta.returns.kind === "void" ? "command" : "reporter"
                : "userproc";
        }

        if (meta.lower === "builds") {
            const [only] = node.body.body;
            if (node.body.body.length !== 1 || only?.type !== "ReturnStatement" || !only.argument) {
                this.error(
                    `A @lower = "builds" proc's body must be exactly one 'return <expression>;'`,
                    node,
                );
            } else {
                meta.buildsExpr = only.argument;
            }
        } else if (meta.operator) {
            this.error(`@operator is only valid on a @lower = "builds" proc`, node);
        }

        if (meta.proccode !== undefined) this.checkProccode(meta.proccode, meta, node);

        // TODO: Implement the features the program currently blocks
        if (
            !meta.opcode &&
            node.returnType?.type === "Type" &&
            (node.returnType.typeName === "list" || node.returnType.typeName === "dict")
        ) {
            this.error(
                `Procedures cannot return '${node.returnType.typeName}' yet (multi-size returns are not supported)`,
                node.returnType,
            );
        }

        const signature: Signature = {
            params: node.parameters,
            returnType: node.returnType,
            meta,
            decorators: node.decorators,
        };
        this.procSignatures.set(node, signature);
        this.declare(
            { kind: "procedure", name: node.name, declNode: node, signatures: [signature] },
            node,
        );
    }

    /**
     * A @proccode placeholder is `%<param name>` or a bare `%s`/`%n`/`%b`, one per param in declaration
     * order. Scratch keys a custom block's arguments off that order, so a mismatch is unloadable, not just wrong.
     * ponytail: no reordering; allow it once someone wants a label that reads out of order.
     */
    private checkProccode(proccode: string, meta: SignatureMeta, node: ProcedureDeclarationNode): void {
        if (meta.lower !== "userproc") {
            this.error(`@proccode is only valid on a proc Katnip emits as a custom block`, node);
            return;
        }

        const holes = [...proccode.matchAll(/%([A-Za-z_][A-Za-z_0-9]*)/g)].map((match) => match[1]!);
        if (holes.length !== node.parameters.length) {
            this.error(
                `@proccode has ${holes.length} placeholder(s) but '${node.name}' takes ${node.parameters.length} parameter(s)`,
                node,
            );
            return;
        }

        holes.forEach((hole, i) => {
            const name = node.parameters[i]!.name;
            if (hole !== name && hole !== "s" && hole !== "n" && hole !== "b")
                this.error(`@proccode placeholder %${hole} must be %${name} (parameter ${i + 1}) or %s/%n/%b`, node);
        });
    }

    /** Return frame shape from the written return type. Only the width (Scratch slot count) matters. */
    private deriveReturns(returnType: TypeNode | null): ReturnMethod {
        if (!returnType) return { kind: "void" };
        if (returnType.type === "TupleType") return { kind: "tuple", width: returnType.elements.length };
        if (returnType.type === "Type" && returnType.typeName === "void") return { kind: "void" };
        if (returnType.type === "Type") {
            const struct = this.current.lookup(returnType.typeName)?.find((s): s is StructSymbol => s.kind === "struct");
            if (struct) return { kind: "tuple", width: struct.fields.length };
        }
        return { kind: "scalar" };
    }

    /** Pulls codegen-relevant decorators (@opcode, @hat) out of a proc's decorator list. */
    private extractMeta(decorators: DecoratorNode[]): SignatureMeta {
        const meta: SignatureMeta = {};
        const loweringKinds: LoweringKind[] = ["reporter", "command", "yields", "userproc", "builds"];
        const retModes = ["auto", "var", "vstack"] as const;
        for (const decorator of decorators) {
            const value = decorator.value.type === "Literal" ? decorator.value.value : undefined;
            if (decorator.name === "opcode" && typeof value === "string") meta.opcode = value;
            if (decorator.name === "operator" && typeof value === "string") meta.operator = value;
            if (decorator.name === "proccode" && typeof value === "string") meta.proccode = value;
            if (decorator.name === "hat") meta.hat = value === "true" || value === true;
            if (decorator.name === "warp") meta.warp = value === "true" || value === true;
            if (decorator.name === "lower") {
                if (typeof value === "string" && (loweringKinds as string[]).includes(value)) {
                    meta.lower = value as LoweringKind;
                } else {
                    this.error(`@lower must be one of: ${loweringKinds.join(", ")}`, decorator);
                }
            }
            if (decorator.name === "ret") {
                if (typeof value === "string" && (retModes as readonly string[]).includes(value)) {
                    meta.ret = value as SignatureMeta["ret"];
                } else {
                    this.error(`@ret must be one of: ${retModes.join(", ")}`, decorator);
                }
            }
        }
        return meta;
    }

    private hoistEnum(node: EnumDeclarationNode): void {
        this.declare(
            { kind: "enum", name: node.name, declNode: node, members: node.members },
            node,
        );
        const values: (string | number)[] = [];
        for (const member of node.members) {
            const implicit = member.value === member.name;
            const value = implicit && !this.inStdlib ? `${node.name}.${member.name}` : member.value;
            this.constMembers.set(`${node.name}.${member.name}`, value);
            values.push(value);
        }
        this.enumValues.set(node.name, values);
    }

    private hoistStruct(node: StructDeclarationNode): void {
        this.declare(
            { kind: "struct", name: node.name, declNode: node, fields: node.fields },
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
            case "VariableDeclaration": {
                // `private` at the top scope is valid: the variable is visible to
                // sprites in this file but cannot be imported into other files.
                const initType = node.initializer ? this.inferType(node.initializer) : null;
                const varType = node.varType ? this.typeFromNode(node.varType) : null;

                if (!initType && !varType) {
                    this.error(`Variable '${node.name}' must have either a type annotation or an initial value`, node);
                }

                if (initType && varType) {
                    this.checkAssign(
                        initType,
                        varType,
                        node.initializer,
                        node,
                        () =>
                            `Variable '${node.name}' of type '${typeToString(varType)}' cannot be initialized with value of type '${typeToString(initType)}'`,
                    );
                }

                // A `public` member was already hoisted into the file scope above; the sprite does not own it.
                const hoisted = this.current.kind === "sprite" && isPublicVar(node);
                if (this.current.kind !== "global" && !hoisted) {
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

                const owner = hoisted ? this.current.parent! : this.current;
                const sym = owner.lookupLocal(node.name)?.find(s => s.declNode === node);
                if (sym) sym.cachedType = varType ?? initType ?? { kind: "unknown" };
                break;
            }
            case "VariableAssignment": {
                const target = this.inferType(node.left);
                const value = this.inferType(node.right);
                this.checkAssign(
                    value,
                    target,
                    node.right,
                    node,
                    () =>
                        `Cannot assign value of type '${typeToString(value)}' to target of type '${typeToString(target)}'`,
                );
                break;
            }
            case "ProcedureDeclaration": {
                const previousReturnType = this.currentReturnType;
                this.currentReturnType = node.returnType
                    ? this.typeFromNode(node.returnType)
                    : { kind: "primitive", name: "void" };
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
                this.currentReturnType = previousReturnType;
                break;
            }
            case "SpriteDeclaration":
                this.enter("sprite");
                // Procs only: `visit` already declares sprite-scoped variables, and enums/structs are top-level.
                for (const stmt of node.body.body)
                    if (stmt.type === "ProcedureDeclaration") this.hoistProcedure(stmt);
                for (const stmt of node.body.body) this.visit(stmt);
                this.exit();
                break;
            case "ImportDeclaration":
                if (this.current.kind !== "global")
                    this.error("Imports are only allowed at the top level of a file", node);
                break;
            case "HandlerStatement": {
                if (this.current.kind !== "sprite") {
                    this.error("Event handlers can only appear at the top level of a sprite", node.call);
                }
                const resolved = this.resolveCall(node.call, true);
                if (resolved.signature && !resolved.signature.meta?.hat) {
                    this.error(
                        `'${this.calleeName(node.call)}' is not a hat block and cannot be used as an event handler`,
                        node.call,
                    );
                }
                this.visitBlock(node.body);
                break;
            }
            case "IfStatement":
                this.checkCondition(node.condition, "'if' statement");
                this.visitBlock(node.thenBlock);
                for (const elif of node.elifs) {
                    this.checkCondition(elif.condition, "'elif' clause");
                    this.visitBlock(elif.block);
                }
                if (node.elseBlock) this.visitBlock(node.elseBlock);
                break;
            case "WhileStatement":
                this.checkCondition(node.condition, "'while' loop");
                this.visitBlock(node.body);
                break;
            case "DoWhileStatement":
                this.checkCondition(node.condition, "'do-while' loop");
                this.visitBlock(node.body);
                break;
            case "ForStatement": {
                const elementType = this.iterationType(this.inferType(node.iterable));
                const isTuple = node.pattern.type === "TupleExpression";
                const loopVars =
                    node.pattern.type === "TupleExpression"
                        ? node.pattern.elements
                        : [node.pattern];

                let partTypes: InternalType[];
                if (!isTuple) {
                    // One variable over a pair (dict, zip, enumerate) binds the first column, as the IR walk does.
                    partTypes = [elementType.kind === "tuple" ? elementType.elements[0]! : elementType];
                } else if (
                    elementType.kind === "tuple" &&
                    elementType.elements.length === loopVars.length
                ) {
                    partTypes = elementType.elements;
                } else {
                    if (elementType.kind !== "unknown") {
                        this.error(
                            `Cannot destructure '${typeToString(elementType)}' into ${loopVars.length} loop variables`,
                            node.pattern,
                        );
                    }
                    partTypes = loopVars.map((): InternalType => ({ kind: "unknown" }));
                }

                this.enter("block");
                loopVars.forEach((loopVar, i) => {
                    if (loopVar.type !== "Identifier") {
                        this.error("Loop variable must be an identifier", loopVar);
                        return;
                    }
                    this.declare(
                        {
                            kind: "loopVar",
                            name: loopVar.name,
                            declNode: loopVar,
                            type: null,
                            cachedType: partTypes[i],
                        },
                        loopVar,
                    );
                });
                for (const stmt of node.body.body) this.visit(stmt);
                this.exit();
                break;
            }
            case "ExpressionStatement":
                this.inferType(node.expression);
                break;
            case "ReturnStatement": {
                if (!this.inProcedure()) {
                    this.error("'return' can only be used inside a procedure", node, "return".length);
                    break;
                }
                const returned: InternalType = node.argument
                    ? this.inferType(node.argument)
                    : { kind: "primitive", name: "void" };
                const expected = this.currentReturnType ?? { kind: "primitive", name: "void" };
                this.checkAssign(
                    returned,
                    expected,
                    node.argument,
                    node.argument ?? node,
                    () =>
                        `Return value of type '${typeToString(returned)}' is not assignable to return type '${typeToString(expected)}'`,
                );
                break;
            }
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

                const previousSwitchType = this.currentSwitchType;
                this.currentSwitchType = this.inferType(node.value);
                for (const caseEntry of node.body) this.visit(caseEntry);
                this.currentSwitchType = previousSwitchType;
                break;
            }
            case "CaseDeclaration":
                for (const caseExpr of node.values) {
                    const labelType = this.inferType(caseExpr);
                    const target = this.currentSwitchType;
                    if (target) {
                        this.checkAssign(
                            labelType,
                            target,
                            caseExpr,
                            caseExpr,
                            () =>
                                `Case label of type '${typeToString(labelType)}' cannot match a switch value of type '${typeToString(target)}'`,
                        );
                    }
                }
                this.visitBlock(node.body);
                break;
            case "DefaultCaseDeclaration":
                this.visitBlock(node.body);
                break;
            case "EnumDeclaration":
                break;
            case "StructDeclaration":
                this.checkStructDeclaration(node);
                break;
            case "ErrorStatement":
                // Error statements come from the parser.
                break;
        }
    }

    /**
     * Validates a struct's fields: unique names, scalar-only types (the flat parallel-list
     * layout can't represent nested aggregates yet), and defaults assignable to their field type.
     */
    private checkStructDeclaration(node: StructDeclarationNode): void {
        const seen = new Set<string>();
        for (const field of node.fields) {
            if (seen.has(field.name)) {
                this.error(`Struct '${node.name}' has a duplicate field '${field.name}'`, field);
            }
            seen.add(field.name);

            const annotated = field.fieldType ? this.typeFromNode(field.fieldType) : null;
            const defaultType = field.default ? this.inferType(field.default) : null;
            const fieldType = annotated ?? defaultType ?? { kind: "unknown" as const };

            if (!this.isScalarFieldType(fieldType)) {
                this.error(
                    `Struct field '${field.name}' has type '${typeToString(fieldType)}'; only scalar fields (num, str, bool, enum) are supported`,
                    field,
                );
            }
            if (annotated && defaultType) {
                this.checkAssign(
                    defaultType,
                    annotated,
                    field.default,
                    field,
                    () =>
                        `Default for field '${field.name}' of type '${typeToString(annotated)}' cannot be a value of type '${typeToString(defaultType)}'`,
                );
            }
        }
    }

    /** A struct field maps to one Scratch scalar slot, so its type must be a single value. */
    private isScalarFieldType(type: InternalType): boolean {
        if (type.kind === "unknown") return true; // don't double-report an already-broken type
        if (type.kind === "enum") return true;
        return type.kind === "primitive" && type.name !== "void";
    }

    /** Three-step reusable block visitor. */
    private visitBlock(block: BlockNode, kind: ScopeKind = "block"): void {
        this.enter(kind);
        for (const statement of block.body) this.visit(statement);
        this.exit();
    }

    /**
     * Reports an error if a condition expression is not of type 'bool'.
     * `unknown` passes: it is the escape hatch for not-yet-typed calls/members,
     * so a single missing type does not cascade into false positives.
     */
    private checkCondition(condition: ExpressionNode, context: string): void {
        const type = this.inferType(condition);
        if (type.kind === "unknown") return;
        if (type.kind !== "primitive" || type.name !== "bool") {
            this.error(
                `${context} condition must be of type 'bool', not '${typeToString(type)}'`,
                condition,
            );
        }
    }

    /** The type produced by one step of iterating over the given iterable type. */
    private iterationType(iterable: InternalType): InternalType {
        switch (iterable.kind) {
            case "list":
                return iterable.element;
            case "dict":
                return { kind: "tuple", elements: [iterable.key, iterable.value] };
            case "tuple":
                // zip()/enumerate() hand back parallel lists; iterating walks them in step.
                return iterable.elements.every((column) => column.kind === "list")
                    ? {
                          kind: "tuple",
                          elements: iterable.elements.map((column) =>
                              column.kind === "list" ? column.element : { kind: "unknown" },
                          ),
                      }
                    : { kind: "unknown" };
            case "primitive":
                // str -> characters, num -> counter value
                return iterable.name === "str" || iterable.name === "num"
                    ? iterable
                    : { kind: "unknown" };
            default:
                return { kind: "unknown" };
        }
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

        if (node.type === "TupleType") {
            return {
                kind: "tuple",
                elements: node.elements.map((element) => this.typeFromNode(element)),
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
                if (node.typeName === "any") return { kind: "unknown" };
                if (this.allowTypevars && /^[A-Z]$/.test(node.typeName)) {
                    return { kind: "typevar", name: node.typeName };
                }
                if (symbols?.some((s) => s.kind === "enum")) {
                    return { kind: "enum", name: node.typeName };
                }
                if (symbols?.some((s) => s.kind === "struct")) {
                    return { kind: "struct", name: node.typeName };
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
        const type = this.computeType(expression);
        this.exprTypes.set(expression, type);
        return type;
    }

    private computeType(expression: ExpressionNode): InternalType {
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

                const bothList = l.kind === "list" && r.kind === "list" && isAssignable(l, r);
                const bothEnum = l.kind === "enum" && r.kind === "enum" && isAssignable(l, r);
                const isComparison =
                    expression.operator === "==" ||
                    expression.operator === "<" ||
                    expression.operator === ">" ||
                    expression.operator === "<=" ||
                    expression.operator === ">=";
                const matchedPair = bothList || (bothEnum && isComparison);

                // `unknown` is the escape hatch (not-yet-typed calls/members);
                // let it pass so one missing type doesn't cascade into errors.
                if (
                    !matchedPair &&
                    l.kind !== "unknown" &&
                    r.kind !== "unknown" &&
                    !(l.kind === "primitive" && r.kind === "primitive")
                ) {
                    this.error(
                        `Cannot use binop between two variables that are not both of type: 'primitive', 'list', or 'enum'`,
                        expression,
                    );
                }

                switch (expression.operator) {
                    // arithmetic
                    case "+":
                        if (l.kind === "list" && matchedPair) return l; // concatenation
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
                return this.resolveCall(expression).type;
            case "DictExpression": {
                if (expression.entries.length == 0)
                    return { kind: "dict", key: { kind: "unknown" }, value: { kind: "unknown" } };

                const firstKeyType = this.inferType(expression.entries[0].key);
                const firstValueType = this.inferType(expression.entries[0].value);

                for (const entry of expression.entries) {
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
                this.error(`Cannot index object of type ${typeToString(objectType)}`, expression);
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
                return this.resolveMemberAccess(expression);
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

    /**
     * Resolves call by shape of callee.
     * Hat blocks are rejected here unless resolving on behalf of a handler.
     */
    private resolveCall(call: CallExpressionNode, asHandler = false): ResolvedCall {
        const args = this.collectArguments(call);

        let resolved: ResolvedCall;
        if (call.object.type === "Identifier") {
            resolved = this.resolveProcedureCall(call, call.object.name, args);
        } else if (call.object.type === "MemberExpression") {
            resolved = this.resolveMemberCall(call, call.object, args);
        } else {
            this.inferType(call.object);
            this.error(`This expression is not callable`, call.object);
            resolved = { type: { kind: "unknown" } };
        }

        if (!asHandler && resolved.signature?.meta?.hat) {
            this.error(
                `'${this.calleeName(call)}' is a hat block and can only be used as an event handler`,
                call,
            );
        }
        if (resolved.signature) this.callResolutions.set(call, resolved.signature);
        return resolved;
    }

    /** Display name of a call's callee for error messages ("add", "motion.move") */
    private calleeName(call: CallExpressionNode): string {
        const callee = call.object;
        if (callee.type === "Identifier") return callee.name;
        if (callee.type === "MemberExpression") {
            const prefix =
                callee.object.type === "Identifier" ? `${callee.object.name}.` : "";
            return `${prefix}${callee.property.name}`;
        }
        return "<expression>";
    }

    /** Parse and enforce argument */
    private collectArguments(call: CallExpressionNode): CallArguments {
        const positional: TypedArgument[] = [];
        const named = new Map<string, TypedArgument>();

        for (const arg of call.arguments) {
            if (arg.type === "NamedArgument") {
                // TODO: a repeated name (same named arg supplied twice) could be reported here before overwriting the map entry.
                named.set(arg.name, { type: this.inferType(arg.value), node: arg.value });
            } else {
                if (named.size > 0) {
                    this.error(`Positional argument cannot follow a named argument`, arg);
                }
                positional.push({ type: this.inferType(arg), node: arg });
            }
        }

        return { positional, named };
    }

    /** Resolves name of call and finds corresponding override */
    private resolveProcedureCall(
        call: CallExpressionNode,
        name: string,
        args: CallArguments,
    ): ResolvedCall {
        const candidates = this.current.lookup(name);
        if (!candidates) {
            this.error(`'${name}' is not defined`, call.object);
            return { type: { kind: "unknown" } };
        }

        // `Point(x = 1, y = 2)` is a struct literal, not a call.
        const struct = candidates.find((s): s is StructSymbol => s.kind === "struct");
        if (struct) return this.resolveStructLiteral(call, struct, args);

        // A name can carry several procedure overloads; anything else isn't callable.
        const overloads = candidates
            .filter((s): s is ProcedureSymbol => s.kind === "procedure")
            .flatMap((s) => s.signatures);
        if (overloads.length === 0) {
            this.error(`'${name}' is not a procedure and cannot be called`, call.object);
            return { type: { kind: "unknown" } };
        }

        return this.callProcedure(call, name, overloads, args);
    }

    /**
     * Validates a struct literal `Struct(field = value, ...)`: named args only, each naming a real field
     * with an assignable value, and every field lacking a default supplied. Returns the struct type.
     */
    private resolveStructLiteral(
        call: CallExpressionNode,
        struct: StructSymbol,
        args: CallArguments,
    ): ResolvedCall {
        const result: ResolvedCall = { type: { kind: "struct", name: struct.name } };
        if (args.positional.length > 0) {
            this.error(`Struct literal '${struct.name}(...)' takes named fields only (e.g. ${struct.name}(x = 1))`, call);
            return result;
        }

        const fieldNames = new Set(struct.fields.map((f) => f.name));
        for (const field of struct.fields) {
            const provided = args.named.get(field.name);
            if (!provided) {
                if (!field.default) this.error(`Struct literal '${struct.name}' is missing required field '${field.name}'`, call);
                continue;
            }
            const fieldType = field.fieldType
                ? this.typeFromNode(field.fieldType)
                : (field.default ? this.inferType(field.default) : { kind: "unknown" as const });
            this.checkAssign(
                provided.type,
                fieldType,
                provided.node,
                provided.node,
                () =>
                    `Field '${field.name}' of struct '${struct.name}' expects '${typeToString(fieldType)}', got '${typeToString(provided.type)}'`,
            );
        }
        for (const [argName, arg] of args.named) {
            if (!fieldNames.has(argName)) this.error(`Struct '${struct.name}' has no field '${argName}'`, arg.node);
        }
        return result;
    }

    /** Resolves a member-callee call: `self.*`, a namespace bltn (motion.move(...)), or a method on a value's type (li.contains(...)) */
    private resolveMemberCall(
        call: CallExpressionNode,
        callee: MemberExpressionNode,
        args: CallArguments,
    ): ResolvedCall {
        const objNode = callee.object;
        const propName = callee.property.name;

        const head = this.resolveMemberHead(objNode);
        switch (head.kind) {
            case "self": case "error": return { type: { kind: "unknown" } };
            case "namespace": {
                const members = head.symbol.scope.lookupLocal(propName);
                if (!members) {
                    this.error(`Namespace '${head.name}' has no member '${propName}'`, callee.property);
                    return { type: { kind: "unknown" } };
                }
                const overloads = members
                    .filter((s): s is ProcedureSymbol => s.kind === "procedure")
                    .flatMap((s) => s.signatures);
                if (overloads.length === 0) {
                    this.error(`'${head.name}.${propName}' is not a procedure and cannot be called`, callee);
                    return { type: { kind: "unknown" } };
                }
                return this.callProcedure(call, `${head.name}.${propName}`, overloads, args);
            }
            case "enum":
                this.error(`'${head.name}.${propName}' is an enum member and cannot be called`, callee);
                return { type: { kind: "unknown" } };
            case "value": break; // fall through to value-method resolution
        }

        const receiver = this.inferType(objNode);
        if (receiver.kind === "unknown") return { type: { kind: "unknown" } };

        const nsName = this.typeHeadNamespace(receiver);
        if (!nsName) {
            this.error(`Type '${typeToString(receiver)}' has no methods`, objNode);
            return { type: { kind: "unknown" } };
        }

        // Stdlib self calls get special case resolving.
        const overloads = (this.stdlibNamespace(nsName)?.scope.lookupLocal(propName) ?? [])
            .filter((s): s is ProcedureSymbol => s.kind === "procedure")
            .flatMap((s) => s.signatures)
            .filter((sig) => sig.params[0]?.name === "self");
        if (overloads.length === 0) {
            this.error(
                `'${propName}' is not a method of type '${typeToString(receiver)}'`,
                callee.property,
            );
            return { type: { kind: "unknown" } };
        }

        const methodArgs: CallArguments = {
            positional: [{ type: receiver, node: objNode }, ...args.positional],
            named: args.named,
        };
        return this.callProcedure(call, propName, overloads, methodArgs);
    }

    /** Resolves a non-call member access: namespace consts (math.pi) etc. */
    private resolveMemberAccess(expr: MemberExpressionNode): InternalType {
        const objNode = expr.object;
        const propName = expr.property.name;

        const head = this.resolveMemberHead(objNode);
        switch (head.kind) {
            case "self": case "error": return { kind: "unknown" };
            case "namespace": {
                const members = head.symbol.scope.lookupLocal(propName);
                if (!members) {
                    this.error(`Namespace '${head.name}' has no member '${propName}'`, expr.property);
                    return { kind: "unknown" };
                }
                const member = members[0];
                if (member.kind === "procedure") {
                    this.error(`'${head.name}.${propName}' is a procedure — call it with (...)`, expr);
                    return { kind: "unknown" };
                }
                return this.typeOf(member);
            }
            case "enum":
                if (!head.symbol.members.some((m) => m.name === propName)) {
                    this.error(`Enum '${head.symbol.name}' has no member '${propName}'`, expr.property);
                    return { kind: "unknown" };
                }
                return { kind: "enum", name: head.symbol.name };
            case "value": break; // fall through to value-member resolution
        }

        const receiver = this.inferType(objNode);
        if (receiver.kind === "unknown") return { kind: "unknown" };

        // Struct field read: `p.x` -> the field's type.
        if (receiver.kind === "struct") {
            const field = this.structField(receiver.name, propName);
            if (!field) {
                this.error(`Struct '${receiver.name}' has no field '${propName}'`, expr.property);
                return { kind: "unknown" };
            }
            return field;
        }
        // Field column on a struct list: `xs.x` -> list<fieldType> (a real parallel column).
        if (receiver.kind === "list" && receiver.element.kind === "struct") {
            const field = this.structField(receiver.element.name, propName);
            if (!field) {
                this.error(`Struct '${receiver.element.name}' has no field '${propName}'`, expr.property);
                return { kind: "unknown" };
            }
            return { kind: "list", element: field };
        }

        const nsName = this.typeHeadNamespace(receiver);
        const members = nsName
            ? this.stdlibNamespace(nsName)?.scope.lookupLocal(propName)
            : null;
        if (members?.some((s) => s.kind === "procedure")) {
            this.error(`'${propName}' is a method — call it with (...)`, expr.property);
        } else {
            this.error(
                `Type '${typeToString(receiver)}' has no member '${propName}'`,
                expr.property,
            );
        }
        return { kind: "unknown" };
    }

    /** Resolves a struct field's type by struct name + field name, or null if absent. */
    private structField(structName: string, fieldName: string): InternalType | null {
        const struct = this.current.lookup(structName)?.find((s): s is StructSymbol => s.kind === "struct");
        const field = struct?.fields.find((f) => f.name === fieldName);
        if (!field) return null;
        return field.fieldType ? this.typeFromNode(field.fieldType) : (field.default ? this.inferType(field.default) : { kind: "unknown" });
    }

    /** Classifies a member expression's object identifier, emitting the shared self/undefined errors. */
    private resolveMemberHead(objNode: MemberExpressionNode["object"]): MemberHead {
        // `ns.Enum.MEMBER`: the head is itself a member expression, so classify the enum here
        // rather than letting inferType turn `ns.Enum` into a value of that enum's type.
        if (objNode.type === "MemberExpression") {
            if (objNode.object.type !== "Identifier") return { kind: "value" };
            const namespace = this.current
                .lookup(objNode.object.name)
                ?.find((s): s is NamespaceSymbol => s.kind === "namespace");
            const enumSym = namespace?.scope
                .lookupLocal(objNode.property.name)
                ?.find((s): s is EnumSymbol => s.kind === "enum");
            return enumSym
                ? { kind: "enum", symbol: enumSym, name: objNode.property.name }
                : { kind: "value" };
        }
        if (objNode.type !== "Identifier") return { kind: "value" };
        if (objNode.name === "self") {
            if (!this.inSprite()) this.error(`'self' can only be used inside a sprite`, objNode);
            return { kind: "self" };
        }
        const symbols = this.current.lookup(objNode.name);
        const namespace = symbols?.find((s): s is NamespaceSymbol => s.kind === "namespace");
        if (namespace) return { kind: "namespace", symbol: namespace, name: objNode.name };
        const enumSym = symbols?.find((s): s is EnumSymbol => s.kind === "enum");
        if (enumSym) return { kind: "enum", symbol: enumSym, name: objNode.name };
        if (!symbols) {
            this.error(`'${objNode.name}' is not defined`, objNode);
            return { kind: "error" };
        }
        return { kind: "value" }; // a plain variable: resolve via its type below
    }

    /** The stdlib namespace that holds methods for a receiver type, if any. */
    private typeHeadNamespace(type: InternalType): string | null {
        switch (type.kind) {
            case "list": return "list";
            case "dict": return "dict";
            case "primitive":
                return type.name === "void" ? null : type.name;
            default:
                return null;
        }
    }

    /** Looks a namespace up directly in the stdlib scope (immune to user shadowing). */
    private stdlibNamespace(name: string): NamespaceSymbol | null {
        return (
            this.stdlibScope
                .lookupLocal(name)
                ?.find((s): s is NamespaceSymbol => s.kind === "namespace") ?? null
        );
    }

    /** Overload selection. */
    private callProcedure(
        call: CallExpressionNode,
        name: string,
        overloads: Signature[],
        args: CallArguments,
    ): ResolvedCall {
        const instantiated = overloads.map((sig) => {
            if (!sig.resolvedParamTypes) return sig;
            const bindings: TypevarBindings = new Map();
            sig.resolvedParamTypes.forEach((paramType, i) => {
                const arg = args.positional[i] ?? args.named.get(sig.params[i]?.name);
                if (arg) bindReceiver(paramType, arg.type, bindings);
            });
            // Cloning would break signature identity, which the IR uses to find a proc's return plan.
            // Only a generic signature needs one, and those are all @opcode builtins with no plan.
            if (bindings.size === 0) return sig;
            return {
                ...sig,
                resolvedParamTypes: sig.resolvedParamTypes.map((t) => substitute(t, bindings)),
                resolvedReturn: sig.resolvedReturn
                    ? substitute(sig.resolvedReturn, bindings)
                    : undefined,
            };
        });

        const match = this.selectOverload(instantiated, args, call, name);
        if (!match) return { type: { kind: "unknown" } };

        const type: InternalType =
            match.resolvedReturn ??
            (match.returnType
                ? this.typeFromNode(match.returnType)
                : { kind: "primitive", name: "void" });
        return { type, signature: match };
    }

    /** Choose the first overload that matches the signiture of the function call */
    private selectOverload(
        overloads: Signature[],
        args: CallArguments,
        call: CallExpressionNode,
        name: string,
    ): Signature | null {
        const single = overloads.length === 1;
        for (const sig of overloads) {
            if (this.bindArguments(sig, args, call, name, single)) return sig;
        }
        if (!single) {
            this.error(`No overload of '${name}' matches these arguments`, call);
        }
        return null;
    }

    /** Checks whether 'args' satisfy one signature. */
    private bindArguments(
        sig: Signature,
        args: CallArguments,
        call: CallExpressionNode,
        name: string,
        report: boolean,
    ): boolean {
        const { params } = sig;
        let ok = true;
        if (args.positional.length > params.length) {
            if (report) {
                this.error(
                    `'${name}' takes at most ${params.length} positional argument${params.length === 1 ? "" : "s"}, got ${args.positional.length}`,
                    call,
                );
            }
            ok = false;
        }

        for (const [i, param] of params.entries()) {
            const positional = args.positional[i];
            const named = args.named.get(param.name);

            if (positional && named) {
                if (report) {
                    this.error(
                        `'${param.name}' is supplied both positionally and by name`,
                        named.node,
                    );
                }
                ok = false;
                continue;
            }

            const provided = positional ?? named;
            if (!provided) {
                if (!param.default) {
                    if (report) {
                        this.error(`Missing argument '${param.name}' in call to '${name}'`, call);
                    }
                    ok = false;
                }
                continue;
            }

            // Stdlib signatures carry pre-resolved types (typevars already
            // substituted); their TypeNodes must not reach typeFromNode here.
            const paramType =
                sig.resolvedParamTypes?.[i] ?? this.typeFromNode(param.paramType);
            const matched = this.checkAssign(
                provided.type,
                paramType,
                provided.node,
                provided.node,
                () =>
                    `Argument '${param.name}' expects ${typeToString(paramType)}, got ${typeToString(provided.type)}`,
                report,
            );
            if (!matched) ok = false;
        }

        for (const [argName, arg] of args.named) {
            if (!params.some((p) => p.name === argName)) {
                if (report) {
                    this.error(`'${name}' has no parameter named '${argName}'`, arg.node);
                }
                ok = false;
            }
        }

        return ok;
    }

    // -- Assignability --

    /**
     * Checks a value expression against a target type, reporting on failure.
     * Prefers the enum-specific diagnostic when the mismatch is an enum one, so every position gets it.
     * @param report false while an overload is being tried speculatively.
     * @returns true when the value is assignable.
     */
    private checkAssign(
        from: InternalType,
        to: InternalType,
        value: ExpressionNode | null,
        at: NodeBase,
        generic: () => string,
        report: boolean = true,
    ): boolean {
        if (isAssignable(from, to, this.assignContext(value))) return true;
        if (report) this.error(this.enumMismatch(from, to, value) ?? generic(), at);
        return false;
    }

    /** Binds a value expression to the enum-literal coercion rule in `isAssignable`. */
    private assignContext(value: ExpressionNode | null): AssignContext {
        return { node: value ?? undefined, accepts: this.acceptsEnumLiteral };
    }

    /** The coercion rule itself: a literal whose value is one of the enum's member values. */
    private readonly acceptsEnumLiteral = (
        enumName: string,
        node: ExpressionNode | undefined,
    ): boolean => {
        const value = literalValue(node);
        return value !== undefined && !!this.enumValues.get(enumName)?.some((v) => v === value);
    };

    /**
     * The tailored message for a value that failed against an enum-typed slot, or null when
     * the mismatch is an ordinary one the caller should describe itself.
     */
    private enumMismatch(
        from: InternalType,
        to: InternalType,
        value: ExpressionNode | null,
    ): string | null {
        if (to.kind !== "enum" || from.kind !== "primitive") return null;
        const members = this.enumValues.get(to.name);
        if (!members) return null;

        const allowed = members.map((m) => JSON.stringify(m)).join(", ");
        const literal = literalValue(value ?? undefined);
        if (literal === undefined) {
            // No cast to an enum exists yet, so point at the member form instead.
            return `Enum '${to.name}' expects one of its members here, not a computed '${typeToString(from)}'; use a member (e.g. ${to.name}.${this.enumFirstMember(to.name)}) or a literal: ${allowed}`;
        }

        const near = nearestMember(literal, members);
        return (
            `${JSON.stringify(literal)} is not a value of enum '${to.name}'; must be one of: ${allowed}` +
            (near !== null ? `. Did you mean ${JSON.stringify(near)}?` : "")
        );
    }

    /** A member name of `enumName`, for the "use a member" hint. */
    private enumFirstMember(enumName: string): string {
        const sym = [...this.constMembers.keys()].find((k) => k.startsWith(`${enumName}.`));
        return sym?.slice(enumName.length + 1) ?? "MEMBER";
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
