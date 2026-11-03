import type { AST, CallExpressionNode, ExpressionNode, NodeBase, TypeNode } from "../parser/AST-nodes.js";
import { typeToString, type InternalType } from "./InternalTypes.js";
import type { SemanticAnalyzer } from "./SemanticAnalyzer.js";
import type { ProcedureSymbol, Scope, Signature } from "./SymbolTable.js";

function isNode(value: unknown): value is NodeBase {
    return typeof value === "object" && value !== null && "type" in value && "loc" in value;
}

function contains(node: NodeBase, line: number, column: number): boolean {
    const { start, end } = node.loc;
    if (line < start.line || line > end.line) return false;
    if (line === start.line && column < start.column) return false;
    if (line === end.line && column >= end.column) return false;
    return true;
}
function identifierAt(root: unknown, line: number, column: number, callees: Map<NodeBase, CallExpressionNode>): { id: ExpressionNode; parent: NodeBase | null } | null {
    let found: { id: ExpressionNode; parent: NodeBase | null } | null = null;
    const visit = (value: unknown, parent: NodeBase | null): void => {
        if (Array.isArray(value)) {
            for (const item of value) visit(item, parent);
            return;
        }
        if (typeof value !== "object" || value === null) return;
        const node = isNode(value) ? value : null;
        if (node?.type === "CallExpression") {
            const call = node as CallExpressionNode;
            callees.set(call.object, call);
        }
        if (node?.type === "Identifier" && contains(node, line, column)) found = { id: node as ExpressionNode, parent };
        for (const [key, child] of Object.entries(value)) {
            if (key !== "loc" && key !== "specifierLoc") visit(child, node ?? parent);
        }
    };
    visit(root, null);
    return found;
}

function typeNodeToString(node: TypeNode): string {
    switch (node.type) {
        case "UnionType":
            return `${typeNodeToString(node.left)} | ${typeNodeToString(node.right)}`;
        case "TupleType":
            return `(${node.elements.map(typeNodeToString).join(", ")})`;
        case "Type": {
            if (!node.typeParams?.length) return node.typeName;
            return `${node.typeName}<${node.typeParams.map(typeNodeToString).join(", ")}>`;
        }
    }
}

function signatureToString(name: string, sig: Signature): string {
    const params = sig.params
        .filter((param) => param.name !== "self")
        .map((param) => {
            const text = `${param.name}: ${typeNodeToString(param.paramType)}`;
            if (param.default) return `${text} = ...`;
            return text;
        });
    let text = `proc ${name}(${params.join(", ")})`;
    if (sig.returnType) text += ` -> ${typeNodeToString(sig.returnType)}`;
    return text;
}

export function hoverAt(ast: AST, analyzer: SemanticAnalyzer, line: number, column: number): string | null {
    const callees = new Map<NodeBase, CallExpressionNode>();
    const found = identifierAt(ast, line, column, callees);
    if (!found) return null;
    const { id, parent } = found;
    if (id.type !== "Identifier") return null;

    let target: NodeBase = id;
    if (parent?.type === "MemberExpression" && (parent as unknown as { property: unknown }).property === id) target = parent;

    const call = callees.get(target);
    const sig = call && analyzer.callResolutions.get(call);
    if (sig) return signatureToString(id.name, sig);

    const type = analyzer.exprTypes.get(target as ExpressionNode);
    if (!type || type.kind === "unknown") return null;
    return `${id.name}: ${typeToString(type)}`;
}

export interface Completion {
    name: string;
    kind: "function" | "field" | "enumMember" | "enum" | "variable";
    detail?: string;
}

function scopeCompletions(scope: Scope, methods: boolean): Completion[] {
    const items: Completion[] = [];
    for (const [name, symbols] of scope.entries()) {
        const symbol = symbols[0]!;
        if (symbol.kind === "procedure") {
            const signatures = symbols
                .flatMap((s) => (s as ProcedureSymbol).signatures)
                .filter((sig) => (sig.params[0]?.name === "self") === methods);
            if (signatures.length === 0) continue;
            items.push({ name, kind: "function", detail: signatures.map((sig) => signatureToString(name, sig)).join("\n") });
        } else if (methods) {
            continue;
        } else if (symbol.kind === "enum") {
            items.push({ name, kind: "enum" });
        } else if (symbol.kind === "variable") {
            items.push({ name, kind: "variable" });
        }
    }
    return items;
}

/** The innermost typed expression ending right where the receiver ends. */
function receiverType(ast: AST, analyzer: SemanticAnalyzer, line: number, column: number): InternalType | null {
    let best: NodeBase | null = null;
    const visit = (value: unknown): void => {
        if (typeof value !== "object" || value === null) return;
        if (isNode(value) && analyzer.exprTypes.has(value as ExpressionNode)) {
            const { start, end } = value.loc;
            if (end.line === line && end.column === column) {
                const later = best && (start.line > best.loc.start.line || (start.line === best.loc.start.line && start.column > best.loc.start.column));
                if (!best || later) best = value;
            }
        }
        for (const [key, child] of Object.entries(value)) {
            if (key !== "loc" && key !== "specifierLoc") visit(child);
        }
    };
    visit(ast);
    if (!best) return null;
    return analyzer.exprTypes.get(best as ExpressionNode) ?? null;
}

/** Members of the receiver ending at a 1-based position; `path` is its text if it's a plain dotted name. */
export function memberCompletions(ast: AST, analyzer: SemanticAnalyzer, path: string[], line: number, column: number): Completion[] {
    const type = receiverType(ast, analyzer, line, column);
    if (type && type.kind !== "unknown" && type.kind !== "enum") {
        const items: Completion[] = [];
        const struct = type.kind === "list" ? type.element : type;
        if (struct.kind === "struct") {
            for (const field of analyzer.structFields(struct.name)) items.push({ name: field.name, kind: "field" });
        }
        const scope = analyzer.methodScope(type);
        if (scope) items.push(...scopeCompletions(scope, true));
        return items;
    }

    const member = analyzer.staticMember(path);
    if (member?.kind === "namespace") return scopeCompletions(member.scope, false);
    if (member?.kind === "enum") return member.members.map((m) => ({ name: m.name, kind: "enumMember" as const, detail: String(m.value) }));
    return [];
}
