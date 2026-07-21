/**
 * @fileoverview Lowers the analyzed AST into IR. Runs after SemanticAnalyzer, and assumes no errors were reported.
 *
 * The core rule from IRNode: no IRExpr may contain a value-returning call. Every expression lowering therefore takes a
 * statement sink; anything needing setup blocks pushes them into the sink and returns an IRExpr naming the result.
 */

import type {
    AST,
    BlockNode,
    ExpressionNode,
    ProcedureDeclarationNode,
    SpriteDeclarationNode,
    StatementNode,
} from "../parser/AST-nodes.js";
import type { InternalType } from "../semantic/InternalTypes.js";
import type { SemanticAnalyzer } from "../semantic/SemanticAnalyzer.js";
import type { ReturnMethod, Signature } from "../semantic/SymbolTable.js";
import {
    paramType,
    type IRExpr,
    type IRParam,
    type IRProc,
    type IRProgram,
    type IRSprite,
    type IRStmt,
} from "./IRNode.js";

/** Per-proc return ABI. */
interface ReturnPlan {
    mangled: string;
    returns: ReturnMethod;
    strategy: "var" | "vstack" | null;
    retVars: string[];
    vlist: string | null;
}

export class IRGenerator {
    private readonly program: IRProgram = {
        procs: new Map(),
        sprites: [],
        variables: [],
        lists: ["_GtempKeys", "_GtempVals"],
    };

    private sprite: IRSprite | null = null;

    private readonly plans = new Map<Signature, ReturnPlan>();
    private readonly usedNames = new Set<string>();
    private currentPlan: ReturnPlan | null = null;

    constructor(private analyzer: SemanticAnalyzer) {}

    generate(ast: AST): IRProgram {
        this.planReturns();
        for (const stmt of ast.body) {
            switch (stmt.type) {
                case "SpriteDeclaration":
                    this.lowerSprite(stmt);
                    break;
                case "VariableDeclaration":
                    this.program.variables.push(stmt.name); // TODO: unmangled; mangle once procs land
                    break;
                case "ProcedureDeclaration":
                case "EnumDeclaration":
                case "ImportDeclaration":
                case "StructDeclaration":
                case "VariableAssignment":
                
                // Statements not supported outside of a sprite declaration must error
                case "HandlerStatement":
                case "SwitchDeclaration":
                case "ExpressionStatement":
                case "IfStatement":
                case "WhileStatement":
                case "DoWhileStatement":
                case "ForStatement":
                case "ReturnStatement":
                    // TODO: error and say its not allowed
                    break;
                case "ErrorStatement":
                    break;
            }
        }
        return this.program;
    }

    private lowerSprite(node: SpriteDeclarationNode): void {
        this.sprite = {
            name: node.name,
            scripts: [],
            variables: [],
            lists: ["_tempKeys", "_tempVals"],
            procs: new Map(),
        };
        this.program.sprites.push(this.sprite);

        for (const stmt of node.body.body) {
            switch (stmt.type) {
                case "HandlerStatement": {
                    const out: IRStmt[] = [];
                    this.sprite.scripts.push({
                        hatOpcode: this.analyzer.callResolutions.get(stmt.call)?.meta?.opcode ?? "",
                        args: stmt.call.arguments.map((a) =>
                            this.lowerExpr(a as ExpressionNode, out),
                        ), // TODO: NamedArgument, and hat args must be literals
                        body: this.lowerBlock(stmt.body),
                    });
                    break;
                }
                case "VariableDeclaration":
                    this.sprite.variables.push(stmt.name);
                    break;
                case "ProcedureDeclaration":
                    this.sprite.procs.set(stmt.name, this.lowerProc(stmt));
                    break;
            }   
        }

        this.sprite = null;
    }

    private planReturns(): void {
        for (const [decl, sig] of this.analyzer.procSignatures) {
            if (sig.meta?.lower !== "userproc") continue;
            const mangled = this.mangle(decl.name);
            const returns = sig.meta.returns ?? { kind: "void" };
            this.plans.set(sig, this.planFor(mangled, returns, sig.meta.retResolved));
        }
    }

    private planFor(mangled: string, returns: ReturnMethod, resolved?: "var" | "vstack"): ReturnPlan {
        if (returns.kind === "void")
            return { mangled, returns, strategy: null, retVars: [], vlist: null };
        if (resolved === "vstack")
            return { mangled, returns, strategy: "vstack", retVars: [], vlist: `${mangled}_stack` };
        const width = returns.kind === "tuple" ? returns.width : 1;
        const retVars =
            width === 1
                ? [`${mangled}_ret`]
                : Array.from({ length: width }, (_, i) => `${mangled}_ret${i}`);
        return { mangled, returns, strategy: "var", retVars, vlist: null };
    }

    private mangle(base: string): string {
        let name = base;
        for (let i = 1; this.usedNames.has(name); i++) name = `${base}_${i}`;
        this.usedNames.add(name);
        return name;
    }

    private lowerProc(stmt: ProcedureDeclarationNode): IRProc {
        const sig = this.analyzer.procSignatures.get(stmt);
        const plan = this.plans.get(sig!)!;
        if (plan.vlist) this.sprite?.lists.push(plan.vlist); // TODO: toplevel procs need handling
        const params: IRParam[] = stmt.parameters.map((param, i) => ({
            name: param.name,
            type: paramTypeOf(sig?.resolvedParamTypes?.[i]),
        }));
        this.currentPlan = plan;
        const body = this.lowerBlock(stmt.body);
        this.currentPlan = null;
        return {
            name: plan.mangled,
            params,
            returns: plan.returns,
            strategy: plan.strategy,
            vlist: plan.vlist,
            retVars: plan.retVars,
            temps: [], // TODO: collected while lowering the body
            body: body,
        };
    }

    private lowerBlock(block: BlockNode): IRStmt[] {
        const out: IRStmt[] = [];
        for (const stmt of block.body) this.lowerStmt(stmt, out);
        return out;
    }

    /** Appends the lowering of one statement to `out`; may append more than one block. */
    private lowerStmt(node: StatementNode, out: IRStmt[]): void {
        switch (node.type) {
            case "IfStatement": {
                // TODO: fold node.elifs into nested else branches, innermost first
                const cond = this.lowerExpr(node.condition, out);
                out.push({
                    kind: "if",
                    cond,
                    then: this.lowerBlock(node.thenBlock),
                    else: node.elseBlock ? this.lowerBlock(node.elseBlock) : [],
                });
                break;
            }
            case "WhileStatement": {
                const cond = this.lowerExpr(node.condition, out);
                out.push({ kind: "while", cond, body: this.lowerBlock(node.body) });
                break;
            }
            case "ReturnStatement": { // TODO: impl the other forms of return statements
                const plan = this.currentPlan!;
                if (node.argument && plan.strategy === "var") {
                    const values = node.argument.type === "TupleExpression"
                        ? node.argument.elements
                        : [node.argument];
                    values.forEach((expr, i) => {
                        const value = this.lowerExpr(expr, out);
                        out.push({
                            kind: "raw",
                            opcode: "data_setvariableto",
                            inputs: [{ kind: "var", name: plan.retVars[i] }, value],
                        });
                    });
                } else if (node.argument && plan.strategy === "vstack") {
                    const values = node.argument.type === "TupleExpression"
                        ? node.argument.elements
                        : [node.argument];
                    values.forEach((expr, _) => {
                        const value = this.lowerExpr(expr, out);
                        out.push({
                            kind: "raw",
                            opcode: "data_addtolist",
                            inputs: [{ kind: "var", name: plan.vlist!}, value]
                        })
                    })
                }
                out.push({ kind: "raw", opcode: "control_stop", inputs: [{ kind: "lit", value: "this script" }] });
                break;
            }
            case "VariableAssignment": {
                if (node.left.type !== "Identifier") break; // TODO: IndexerAccess -> replaceitemoflist, member -> struct write
                const value: IRExpr =
                    node.operator === "="
                        ? this.lowerExpr(node.right, out)
                        : {
                              kind: "op",
                              opcode: binaryOpcodes[node.operator.slice(0, -1)],
                              inputs: [this.lowerExpr(node.left, out), this.lowerExpr(node.right, out)],
                          };
                out.push({ kind: "raw", opcode: "data_setvariableto", inputs: [{ kind: "var", name: node.left.name }, value] });
                break;
            }
            case "VariableDeclaration": {
                const init = node.initializer ? this.lowerExpr(node.initializer, out) : null;
                out.push({
                    kind: "raw",
                    opcode: "data_setvariableto",
                    inputs: [{ kind: "var", name: node.name }, init ?? { kind: "lit", value: "" }],
                });
                break;
            }
            case "ExpressionStatement": {
                const expr = node.expression;
                if (expr.type === "CallExpression") {
                    const sig = this.analyzer.callResolutions.get(expr)!;
                    if (sig.meta?.lower === "command") {
                        const args = sig.params.map((p, i) =>
                            this.lowerExpr((expr.arguments[i] ?? p.default!) as ExpressionNode, out),
                        );
                        out.push({ kind: "raw", opcode: sig.meta.opcode!, inputs: args });
                        break;
                    }
                }
                this.lowerExpr(node.expression, out);
                // `lowerExpr()` will automatically parse a userproc call and emit it; 
                // we ignore the return if its anything else (reporter/yields), as it shouldn't be here
                break;
            }
        }
    }

    /**
     * Lowers an expression, pushing any setup statements into `out`.
     * The returned IRExpr is always call-free.
     */
    private lowerExpr(node: ExpressionNode, out: IRStmt[]): IRExpr {
        switch (node.type) {
            case "Literal":
                return { kind: "lit", value: node.value ?? "" };

            case "Identifier":
                // TODO: needs analyzer.identBindings to tell param from var from enum member
                return { kind: "var", name: node.name };

            case "BinaryExpression": {
                const left = this.lowerExpr(node.left, out);
                const right = this.lowerExpr(node.right, out);
                // TODO: `+` over str operands is operator_join, not operator_add- needs analyzer.exprTypes
                return { kind: "op", opcode: binaryOpcodes[node.operator], inputs: [left, right] };
            }
            case "CallExpression": {
                const sig = this.analyzer.callResolutions.get(node)!;
                const args = sig.params.map((param, i) => {
                    return this.lowerExpr((node.arguments[i] ?? param.default!) as ExpressionNode, out);
                });

                if (sig.meta?.lower === "reporter") return { kind: "op", opcode: sig.meta.opcode!, inputs: args };

                const plan = this.plans.get(sig)!;
                out.push({ kind: "call", proc: plan.mangled, args });

                if (plan.strategy === "var") {
                    if (plan.returns.kind === "scalar") {
                        return { kind: "var", name: plan.retVars[0] }
                    }
                    if (plan.returns.kind === "tuple") {

                    }
                } else if (plan.strategy === "vstack") {
                    if (plan.returns.kind === "scalar") {
                        return { kind: "stackref", list: plan.vlist!, depth: 0 }
                    }
                }
            }

            // TODO: UnaryExpression, InterpolatedString (nested operator_join),
            // MemberExpression, IndexerAccess, SliceAccess
        }
        return { kind: "lit", value: "" };
    }
}

/** Scratch inputs are only %n, %s, %b; num -> NUMBER, bool -> BOOLEAN, everything else -> STRING. */
function paramTypeOf(type?: InternalType): paramType {
    if (type?.kind === "primitive") {
        if (type.name === "num") return paramType.NUMBER;
        if (type.name === "bool") return paramType.BOOLEAN;
    }
    return paramType.STRING;
}

const binaryOpcodes: Record<string, string> = {
    "+": "operator_add",
    "-": "operator_subtract",
    "*": "operator_multiply",
    "/": "operator_divide",
    "%": "operator_mod",
    "==": "operator_equals",
    "<": "operator_lt",
    ">": "operator_gt",
    "&&": "operator_and",
    "||": "operator_or",
    // TODO: **, <=, >=, and the negated ops (!&, !|, !^, ^) have no direct opcode; need to be composed
}