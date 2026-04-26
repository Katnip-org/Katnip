/**
 * @fileoverview Contains the semantic analysis logic for the Katnip compiler, including type checking and symbol resolution.
 */

import type { AST, StatementNode, ExpressionNode, BlockNode, MemberExpressionNode, VariableDeclarationNode, VariableAssignmentNode, ProcedureDeclarationNode, EnumDeclarationNode, IfStatementNode, WhileStatementNode, DoWhileStatementNode, ForStatementNode, SwitchDeclarationNode } from "../parser/AST-nodes.js";
import { VariableDeclarationType } from "../parser/AST-nodes.js";
import { ErrorReporter, KatnipError } from "../utils/ErrorReporter.js";
import type { Scope, ScopeEntry } from "./SymbolTable.js";
import { type InternalType, UNKNOWN, toDisplayString, typesCompatible, typeNodeToInternalType, bindTypeVars, substituteTypeVars } from "./InternalType.js";
import { type BuiltinMember, type BuiltinFunctionSignature, builtinFunctions, builtinNamespaces, builtinValues, typeMethods } from "./Builtins.js";

const SPRITE_BUILTIN_PROPS: Record<string, InternalType> = {
    x: { kind: "primitive", name: "num" },
    y: { kind: "primitive", name: "num" },
    direction: { kind: "primitive", name: "num" },
    size: { kind: "primitive", name: "num" },
    volume: { kind: "primitive", name: "num" },
    costume: { kind: "primitive", name: "str" },
    costumeNumber: { kind: "primitive", name: "num" },
};

export class SemanticAnalyzer {
    private scopeStack: Scope[] = [{}];

    constructor(private reporter: ErrorReporter) {}

    /**
     * Entry point - walks the top-level AST and checks all statements.
     * @param ast - The parsed AST to check.
     */
    check(ast: AST): void {
        this.prePass(ast.body);
        for (const node of ast.body) {
            this.checkStatement(node);
        }
    }

    private prePass(statements: StatementNode[]): void {
        // Collect globals from top-level and inside sprites, check conflicts
        const allStatements = [...statements, ...statements
            .filter(n => n.type === "SpriteDeclaration")
            .flatMap(n => (n as any).body.body as StatementNode[])
        ];
        for (const node of allStatements) {
            if (node.type === "VariableDeclaration" && node.access === VariableDeclarationType.global && node.varType) {
                const type = typeNodeToInternalType(node.varType);
                this.declare(node.name, { kind: "variable", type, access: VariableDeclarationType.global }, node.loc.start);
            }
        }
        // Register each sprite as a typed namespace of its readable props
        for (const node of statements) {
            if (node.type === "SpriteDeclaration") {
                const props: Record<string, InternalType> = { ...SPRITE_BUILTIN_PROPS };
                for (const stmt of node.body.body) {
                    if (stmt.type === "VariableDeclaration" && stmt.access === VariableDeclarationType.public && stmt.varType)
                        props[stmt.name] = typeNodeToInternalType(stmt.varType);
                }
                this.declare(node.name, { kind: "sprite", props }, node.loc.start);
            }
        }
    }

    /**
     * Dispatches a statement node to the appropriate check method.
     * @param node - The statement to check.
     */
    private checkStatement(node: StatementNode): void {
        switch (node.type) {
            case "VariableDeclaration": return this.checkVariableDeclaration(node);
            case "VariableAssignment": return this.checkVariableAssignment(node);
            case "ProcedureDeclaration": return this.checkProcedureDeclaration(node);
            case "EnumDeclaration": return this.checkEnumDeclaration(node);
            case "SpriteDeclaration": return this.checkBlock(node.body);
            case "HandlerStatement": return this.checkBlock(node.body);
            case "IfStatement": return this.checkIfStatement(node);
            case "WhileStatement": return this.checkWhileStatement(node);
            case "DoWhileStatement": return this.checkDoWhileStatement(node);
            case "ForStatement": return this.checkForStatement(node);
            case "SwitchDeclaration": return this.checkSwitchStatement(node);
            case "ExpressionStatement": this.resolveType(node.expression); return;
            case "CaseDeclaration":
            case "DefaultCaseDeclaration":
                this.reporter.add(new KatnipError("Semantic", "case/default outside of switch", node.loc.start));
                return;
        }
    }

    /**
     * Pushes a new scope onto the stack, checks all statements in the block, then pops it.
     * @param block - The block node to check.
     */
    private checkBlock(block: BlockNode): void {
        this.pushScope();
        for (const stmt of block.body) {
            this.checkStatement(stmt);
        }
        this.popScope();
    }

    /**
     * Checks a variable declaration, inferring type from the initializer if no annotation is present.
     * @param node - The variable declaration node.
     */
    private checkVariableDeclaration(node: VariableDeclarationNode): void {
        if (node.access === VariableDeclarationType.global && node.varType === null) {
            this.reporter.add(new KatnipError("Semantic", `Global variable '${node.name}' must have a type annotation`, node.loc.start));
            return;
        }

        let type: InternalType;
        if (node.varType !== null) {
            type = typeNodeToInternalType(node.varType);
            this.checkEnumTypeExists(type, node.varType.loc.start);
        } else if (node.initializer !== null) {
            type = this.widenLiteral(this.resolveType(node.initializer));
        } else {
            this.reporter.add(new KatnipError("Semantic", `'${node.name}' must have a type annotation or initializer`, node.loc.start));
            return;
        }

        if (node.initializer !== null) {
            const initType = this.resolveType(node.initializer);
            if (!typesCompatible(type, initType)) {
                this.reporter.add(new KatnipError("Semantic", `Cannot initialize '${node.name}' (type '${toDisplayString(type)}') with a value of type '${toDisplayString(this.widenLiteral(initType))}'`, node.loc.start));
            }
        }

        if (node.access !== VariableDeclarationType.global)
            this.declare(node.name, { kind: "variable", type, access: node.access }, node.loc.start);
    }

    /**
     * Checks that the right-hand side type is compatible with the left-hand side.
     * @param node - The variable assignment node.
     */
    private checkVariableAssignment(node: VariableAssignmentNode): void {
        if (node.left.type === "MemberExpression" && node.left.object.type === "Identifier") {
            const sym = this.lookup(node.left.object.name);
            if (sym?.kind === "sprite") {
                this.reporter.add(new KatnipError("Semantic", `Cannot assign to '${node.left.object.name}.${node.left.property.name}' — cross-sprite assignment is not allowed`, node.loc.start));
                return;
            }
        }

        const leftType  = this.resolveType(node.left);
        const rightType = this.resolveType(node.right);

        if (!typesCompatible(leftType, rightType)) {
            const leftName = node.left.type === "Identifier" ? ` to '${node.left.name}'` : "";
            this.reporter.add(new KatnipError("Semantic", `Cannot assign '${toDisplayString(this.widenLiteral(rightType))}'${leftName} - expected type '${toDisplayString(leftType)}'`, node.loc.start));
        }
    }

    /**
     * Registers the procedure in the current scope, then checks its body in a new scope containing its parameters.
     * @param node - The procedure declaration node.
     */
    private checkProcedureDeclaration(node: ProcedureDeclarationNode): void {
        const returnType = node.returnType ? typeNodeToInternalType(node.returnType) : { kind: "primitive", name: "void" } satisfies InternalType;
        const params = node.parameters.map(param => ({ name: param.name, type: typeNodeToInternalType(param.paramType) }));

        this.declare(node.name, { kind: "function", params, returnType }, node.loc.start);

        this.pushScope();
        for (const param of node.parameters) {
            const paramType = typeNodeToInternalType(param.paramType);
            this.checkEnumTypeExists(paramType, param.paramType.loc.start);
            this.declare(param.name, { kind: "variable", type: paramType, access: VariableDeclarationType.temp }, param.loc.start);
        }
        for (const stmt of node.body) {
            this.checkStatement(stmt);
        }
        this.popScope();
    }

    /**
     * Registers the enum and its members in the current scope.
     * @param node - The enum declaration node.
     */
    private checkEnumDeclaration(node: EnumDeclarationNode): void {
        this.declare(node.name, { kind: "enum", members: node.members.map(String) }, node.loc.start);
    }

    /**
     * Checks an if/elif/else statement, verifying that all conditions are bool.
     * @param node - The if statement node.
     */
    private checkIfStatement(node: IfStatementNode): void {
        const condType = this.resolveType(node.condition);
        if (!typesCompatible(condType, { kind: "primitive", name: "bool" })) {
            this.reporter.add(new KatnipError("Semantic", `Condition must be 'bool', got '${toDisplayString(condType)}'`, node.condition.loc.start));
        }

        this.checkBlock(node.thenBlock);

        for (const elif of node.elifs) {
            const elifCondType = this.resolveType(elif.condition);
            if (!typesCompatible(elifCondType, { kind: "primitive", name: "bool" })) {
                this.reporter.add(new KatnipError("Semantic", `Condition must be 'bool', got '${toDisplayString(elifCondType)}'`, elif.condition.loc.start));
            }
            this.checkBlock(elif.block);
        }

        if (node.elseBlock) this.checkBlock(node.elseBlock);
    }

    /**
     * Checks a while statement, verifying the condition is bool.
     * @param node - The while statement node.
     */
    private checkWhileStatement(node: WhileStatementNode): void {
        const condType = this.resolveType(node.condition);
        if (!typesCompatible(condType, { kind: "primitive", name: "bool" })) {
            this.reporter.add(new KatnipError("Semantic", `Condition must be 'bool', got '${toDisplayString(condType)}'`, node.condition.loc.start));
        }
        this.checkBlock(node.body);
    }

    /**
     * Checks a do-while statement, verifying the condition is bool.
     * @param node - The do-while statement node.
     */
    private checkDoWhileStatement(node: DoWhileStatementNode): void {
        this.checkBlock(node.body);
        const condType = this.resolveType(node.condition);
        if (!typesCompatible(condType, { kind: "primitive", name: "bool" })) {
            this.reporter.add(new KatnipError("Semantic", `Condition must be 'bool', got '${toDisplayString(condType)}'`, node.condition.loc.start));
        }
    }

    /**
     * Checks a for statement, binding loop variables to the iterable's element type.
     * A num iterable is treated as a range loop; a list iterable yields its element type.
     * Tuple patterns are destructured against a tuple element type.
     * @param node - The for statement node.
     */
    private checkForStatement(node: ForStatementNode): void {
        this.pushScope();

        const iterableType = this.resolveType(node.iterable);
        let elementType: InternalType;

        if (iterableType.kind === "primitive" && iterableType.name === "num") {
            elementType = { kind: "primitive", name: "num" };
        } else if (iterableType.kind === "list") {
            elementType = iterableType.element;
        } else {
            elementType = UNKNOWN;
        }

        if (node.pattern.type === "Identifier") {
            this.declare(node.pattern.name, { kind: "variable", type: elementType, access: VariableDeclarationType.temp }, node.pattern.loc.start);
        } else {
            for (let i = 0; i < node.pattern.elements.length; i++) {
                const el = node.pattern.elements[i];
                if (el.type === "Identifier") {
                    const memberType: InternalType = elementType.kind === "tuple" && i < elementType.elements.length
                        ? elementType.elements[i]
                        : UNKNOWN;
                    this.declare(el.name, { kind: "variable", type: memberType, access: VariableDeclarationType.temp }, el.loc.start);
                }
            }
        }

        for (const stmt of node.body.body) {
            this.checkStatement(stmt);
        }

        this.popScope();
    }

    /**
     * Checks a switch statement, verifying case value types match the switch expression.
     * @param node - The switch declaration node.
     */
    private checkSwitchStatement(node: SwitchDeclarationNode): void {
        const switchType = this.resolveType(node.value);

        for (const arm of node.body) {
            if (arm.type === "CaseDeclaration") {
                for (const val of arm.values) {
                    const valType = this.resolveType(val);
                    if (!typesCompatible(switchType, valType)) {
                        this.reporter.add(new KatnipError("Semantic", `Case value '${toDisplayString(valType)}' doesn't match switch type '${toDisplayString(switchType)}'`, val.loc.start));
                    }
                }
            }
            this.checkBlock(arm.body);
        }
    }

    /**
     * Resolves the InternalType of an expression, reporting errors for mismatches or undefined names.
     * @param node - The expression node to resolve.
     * @returns The resolved InternalType, or UNKNOWN if the type cannot be determined.
     */
    resolveType(node: ExpressionNode): InternalType {
        switch (node.type) {
            case "Literal":
                if (node.valueType === "Null") return { kind: "primitive", name: "void" };
                return { kind: "literal", value: node.value as string | number };

            case "Identifier": {
                const builtin = builtinValues[node.name];
                if (builtin) return builtin;

                const sym = this.lookup(node.name);
                if (!sym) {
                    this.reporter.add(new KatnipError("Semantic", `'${node.name}' is not defined`, node.loc.start));
                    return UNKNOWN;
                }
                if (sym.kind === "variable") return sym.type;
                if (sym.kind === "function") return sym.returnType;
                if (sym.kind === "enum") return { kind: "enum", name: node.name };
                return UNKNOWN;
            }

            case "InterpolatedString":
                return { kind: "primitive", name: "str" };

            case "BinaryExpression": {
                const left  = this.widenLiteral(this.resolveType(node.left));
                const right = this.widenLiteral(this.resolveType(node.right));
                if (!typesCompatible(left, right)) {
                    this.reporter.add(new KatnipError("Semantic", `Type mismatch: '${toDisplayString(left)}' and '${toDisplayString(right)}'`, node.loc.start));
                    return UNKNOWN;
                }
                if (["==", "<", ">", "<=", ">=", "&&", "||", "!&", "!|", "^", "!^"].includes(node.operator)) {
                    return { kind: "primitive", name: "bool" };
                }
                return left;
            }

            case "UnaryExpression": {
                const argType = this.resolveType(node.argument);
                if (node.operator === "!") return { kind: "primitive", name: "bool" };
                return argType;
            }

            case "CallExpression": {
                const argNodes = node.arguments.map(arg => arg.type === "NamedArgument" ? arg.value : arg);
                const argTypes = argNodes.map(arg => this.resolveType(arg));

                if (node.object.type === "Identifier") {
                    const sym = this.lookup(node.object.name);
                    if (sym?.kind === "function") {
                        this.checkCallArgs(sym.params.map(p => p.type), argTypes, argNodes, node.object.name);
                        return sym.returnType;
                    }

                    const builtin = builtinFunctions[node.object.name];
                    if (builtin) return this.resolveBuiltinCall(builtin.overloads, argTypes, {}, node.object.name, argNodes);
                }

                if (node.object.type === "MemberExpression") {
                    const member = this.resolveBuiltinMember(node.object);
                    if (member?.kind === "function") {
                        const label = `${node.object.object.type === "Identifier" ? node.object.object.name + "." : ""}${node.object.property.name}`;
                        return this.resolveBuiltinCall(member.overloads, argTypes, {}, label, argNodes);
                    }

                    // type methods: myList.push(...), myStr.length(), etc.
                    if (node.object.object.type === "Identifier") {
                        const sym = this.lookup(node.object.object.name);
                        if (sym?.kind === "variable") {
                            const varType = sym.type;
                            const typeKey = varType.kind === "primitive" ? varType.name : varType.kind;
                            const methodNs = typeMethods[typeKey];
                            const method = methodNs?.[node.object.property.name];
                            if (method?.kind === "function") {
                                const preBindings: Record<string, InternalType> = {};
                                if (varType.kind === "list") preBindings["T"] = varType.element;
                                const label = `${node.object.object.name}.${node.object.property.name}`;
                                return this.resolveBuiltinCall(method.overloads, argTypes, preBindings, label, argNodes);
                            }
                        }
                    }
                }

                return UNKNOWN;
            }

            case "MemberExpression": {
                if (node.object.type === "Identifier") {
                    const sym = this.lookup(node.object.name);
                    if (sym?.kind === "enum") {
                        if (!sym.members.includes(node.property.name)) {
                            this.reporter.add(new KatnipError("Semantic", `'${node.property.name}' is not a member of enum '${node.object.name}'`, node.property.loc.start));
                        }
                        return { kind: "enum", name: node.object.name };
                    }
                    if (sym?.kind === "sprite") {
                        const propType = sym.props[node.property.name];
                        if (!propType)
                            this.reporter.add(new KatnipError("Semantic", `'${node.property.name}' is not a public property of sprite '${node.object.name}'`, node.property.loc.start));
                        return propType ?? UNKNOWN;
                    }
                }

                const member = this.resolveBuiltinMember(node);
                if (member?.kind === "value") return member.type;

                return UNKNOWN;
            }

            case "IndexerAccess": {
                const objType   = this.resolveType(node.object);
                const indexType = this.resolveType(node.index);

                if (objType.kind === "list") {
                    if (!typesCompatible(indexType, { kind: "primitive", name: "num" })) {
                        this.reporter.add(new KatnipError("Semantic", `List index must be 'num', got '${toDisplayString(indexType)}'`, node.index.loc.start));
                    }
                    return objType.element;
                }
                if (objType.kind === "dict") {
                    if (!typesCompatible(indexType, objType.key)) {
                        this.reporter.add(new KatnipError("Semantic", `Dict key must be '${toDisplayString(objType.key)}', got '${toDisplayString(indexType)}'`, node.index.loc.start));
                    }
                    return objType.value;
                }
                return UNKNOWN;
            }

            case "SliceAccess": {
                const objType = this.resolveType(node.object);
                if (objType.kind !== "list") {
                    this.reporter.add(new KatnipError("Semantic", "Slice access is only valid on lists", node.object.loc.start));
                    return UNKNOWN;
                }
                return objType;
            }

            case "ListExpression": {
                if (node.elements.length === 0) return { kind: "list", element: UNKNOWN };
                const elementTypes = node.elements.map(el => this.widenLiteral(this.resolveType(el)));
                const elementType = elementTypes.slice(1).reduce<InternalType>((acc, t) =>
                    typesCompatible(acc, t) && typesCompatible(t, acc) ? acc : { kind: "union", left: acc, right: t },
                    elementTypes[0]
                );
                return { kind: "list", element: elementType };
            }

            case "DictExpression": {
                if (node.entries.length === 0) return { kind: "dict", key: UNKNOWN, value: UNKNOWN };
                const keyType   = this.widenLiteral(this.resolveType(node.entries[0].key));
                const valueType = this.widenLiteral(this.resolveType(node.entries[0].value));
                const allSame   = node.entries.every(e =>
                    typesCompatible(keyType, this.widenLiteral(this.resolveType(e.key))) &&
                    typesCompatible(valueType, this.widenLiteral(this.resolveType(e.value)))
                );
                if (!allSame) {
                    this.reporter.add(new KatnipError("Semantic", "Dict entries must all have the same key and value types", node.loc.start));
                    return UNKNOWN;
                }
                return { kind: "dict", key: keyType, value: valueType };
            }

            case "TupleExpression":
                return { kind: "tuple", elements: node.elements.map(el => this.resolveType(el)) };

            case "EmptyExpression":
                return { kind: "primitive", name: "void" };

            case "ErrorToken":
                return UNKNOWN;
        }
    }

    /**
     * Resolves the return type of a builtin function call by matching an overload and substituting type vars.
     * @param overloads - The candidate overloads for this function.
     * @param argTypes  - The resolved types of the call's arguments.
     * @returns The concrete return type after type var substitution, or UNKNOWN if no overload matches.
     */
    private resolveBuiltinCall(overloads: BuiltinFunctionSignature[], argTypes: InternalType[], preBindings: Record<string, InternalType> = {}, label?: string, argNodes?: ExpressionNode[]): InternalType {
        const match = overloads.find(o =>
            o.params.length === argTypes.length &&
            o.params.every((param, i) => typesCompatible(param.type, argTypes[i]))
        ) ?? overloads.find(o => o.params.length === argTypes.length);

        if (!match) {
            if (label) {
                const expected = overloads.map(o => o.params.length).join(" or ");
                this.reporter.add(new KatnipError("Semantic", `'${label}' expects ${expected} argument(s), got ${argTypes.length}`, argNodes?.[0]?.loc.start ?? { line: 0, column: 0 }));
            }
            return UNKNOWN;
        }

        const bindings: Record<string, InternalType> = { ...preBindings };
        for (let i = 0; i < match.params.length; i++) {
            bindTypeVars(match.params[i].type, argTypes[i], bindings);
        }

        if (argNodes) {
            for (let i = 0; i < match.params.length; i++) {
                const expectedType = substituteTypeVars(match.params[i].type, bindings);
                if (!typesCompatible(expectedType, argTypes[i])) {
                    this.reporter.add(new KatnipError("Semantic", `Argument '${match.params[i].name}' of '${label}' expects '${toDisplayString(expectedType)}', got '${toDisplayString(this.widenLiteral(argTypes[i]))}'`, argNodes[i]?.loc.start ?? { line: 0, column: 0 }));
                }
            }
        }

        return substituteTypeVars(match.returnType, bindings);
    }

    private checkCallArgs(paramTypes: InternalType[], argTypes: InternalType[], argNodes: ExpressionNode[], label: string): void {
        if (paramTypes.length !== argTypes.length) {
            this.reporter.add(new KatnipError("Semantic", `'${label}' expects ${paramTypes.length} argument(s), got ${argTypes.length}`, argNodes[0]?.loc.start ?? { line: 0, column: 0 }));
            return;
        }
        for (let i = 0; i < paramTypes.length; i++) {
            if (!typesCompatible(paramTypes[i], argTypes[i])) {
                this.reporter.add(new KatnipError("Semantic", `Argument ${i + 1} of '${label}' expects '${toDisplayString(paramTypes[i])}', got '${toDisplayString(this.widenLiteral(argTypes[i]))}'`, argNodes[i]?.loc.start ?? { line: 0, column: 0 }));
            }
        }
    }

    /**
     * Walks a MemberExpression to find the matching BuiltinMember, handling nested namespaces.
     * @param node - The member expression to resolve.
     * @returns The BuiltinMember if found, or null.
     */
    private resolveBuiltinMember(node: MemberExpressionNode): BuiltinMember | null {
        if (node.object.type === "Identifier") {
            const ns = builtinNamespaces[node.object.name];
            return ns?.[node.property.name] ?? null;
        }
        if (node.object.type === "MemberExpression") {
            const parent = this.resolveBuiltinMember(node.object);
            const members = parent?.kind === "namespace" || parent?.kind === "value" ? parent.members : null;
            if (members) return members[node.property.name] ?? null;
        }
        return null;
    }

    /**
     * Strips a literal type to its base primitive, used where specific values aren't meaningful.
     * @param t - The type to widen.
     * @returns The base primitive type, or t unchanged if it isn't a literal.
     */
    private widenLiteral(t: InternalType): InternalType {
        if (t.kind !== "literal") return t;
        return { kind: "primitive", name: typeof t.value === "string" ? "str" : "num" };
    }

    private checkEnumTypeExists(type: InternalType, loc: { line: number; column: number }): void {
        if (type.kind === "enum") {
            const sym = this.lookup(type.name);
            if (!sym || sym.kind !== "enum")
                this.reporter.add(new KatnipError("Semantic", `Unknown type '${type.name}'`, loc));
        }
    }

    /**
     * Pushes a new empty scope onto the scope stack.
     */
    private pushScope(): void {
        this.scopeStack.push({});
    }

    /**
     * Pops the innermost scope from the scope stack.
     */
    private popScope(): void {
        this.scopeStack.pop();
    }

    /**
     * Declares a symbol in the innermost scope, reporting an error if the name is already taken.
     * @param name - The symbol name.
     * @param symbol - The symbol to register.
     * @param loc - The source location for error reporting.
     */
    private declare(name: string, symbol: ScopeEntry, loc: { line: number; column: number }): void {
        const current = this.scopeStack[this.scopeStack.length - 1];
        if (current[name]) {
            this.reporter.add(new KatnipError("Semantic", `'${name}' is already declared in this scope`, loc));
            return;
        }
        current[name] = symbol;
    }

    /**
     * Walks the scope stack from innermost to outermost, returning the first matching symbol.
     * @param name - The symbol name to look up.
     * @returns The found symbol, or null if not declared.
     */
    private lookup(name: string): ScopeEntry | null {
        for (let i = this.scopeStack.length - 1; i >= 0; i--) {
            if (this.scopeStack[i][name]) return this.scopeStack[i][name];
        }
        return null;
    }
}
