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
    TypeNode,
} from "../parser/AST-nodes.js";
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
    vStackName: string | null;
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

    /** Binary operators with no Scratch block, mapped to the @lower = "builds" proc that composes them. */
    private readonly operatorProcs = new Map<string, Signature>();
    /** Param name -> operand, while inlining a "builds" body. */
    private substitutions: Map<string, IRExpr> | null = null;

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
                case "ProcedureDeclaration": {
                    const proc = this.lowerProc(stmt);
                    if (proc) this.program.procs.set(proc.name, proc);
                    break;
                }
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
                case "ProcedureDeclaration": {
                    const proc = this.lowerProc(stmt);
                    if (proc) this.sprite.procs.set(stmt.name, proc);
                    break;
                }
            }   
        }

        this.sprite = null;
    }

    private planReturns(): void {
        for (const [decl, sig] of this.analyzer.procSignatures) {
            if (sig.meta?.operator) this.operatorProcs.set(sig.meta.operator, sig);
            if (sig.meta?.lower !== "userproc") continue;

            const mangled = this.mangle(decl.name);
            const returns = sig.meta.returns ?? { kind: "void" };

            this.plans.set(sig, this.planFor(mangled, returns, sig.meta.retResolved));
        }
    }

    private planFor(mangled: string, returns: ReturnMethod, resolved?: "var" | "vstack"): ReturnPlan {
        if (returns.kind === "void")
            return { mangled, returns, strategy: null, retVars: [], vStackName: null };
        if (resolved === "vstack")
            return { mangled, returns, strategy: "vstack", retVars: [], vStackName: `${mangled}_stack` };
        const width = returns.kind === "tuple" ? returns.width : 1;

        let retVars;
        if (width === 1)
            retVars = [`${mangled}_ret`];
        else
            retVars = Array.from({ length: width }, (_, i) => `${mangled}_ret${i}`);

        return { mangled, returns, strategy: "var", retVars, vStackName: null };
    }

    private mangle(base: string): string {
        let name = base;
        for (let i = 1; this.usedNames.has(name); i++) name = `${base}_${i}`;
        this.usedNames.add(name);
        return name;
    }

    /** Returns null for procs that aren't lowered as userprocs (@opcode don't have bodies). */
    private lowerProc(stmt: ProcedureDeclarationNode): IRProc | null {
        const sig = this.analyzer.procSignatures.get(stmt);
        const plan = sig && this.plans.get(sig);
        if (!plan) return null;

        if (plan.vStackName) (this.sprite ?? this.program).lists.push(plan.vStackName);

        const params: IRParam[] = stmt.parameters.map((param) => ({
            name: param.name,
            type: paramTypeOf(param.paramType),
        }));

        this.currentPlan = plan;
        const body = this.lowerBlock(stmt.body);
        this.currentPlan = null;

        return {
            name: plan.mangled,
            params,
            returns: plan.returns,
            strategy: plan.strategy,
            vStackName: plan.vStackName,
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
                const cond = this.lowerExpr(node.condition, out);

                let elseStmt: IRStmt[] = node.elseBlock ? this.lowerBlock(node.elseBlock) : [];

                for (let idx = (node.elifs?.length ?? 0) - 1; idx >= 0; idx--) {
                    const elif = node.elifs![idx];
                    const pre: IRStmt[] = [];
                    const elifCond = this.lowerExpr(elif.condition, pre);
                    elseStmt = [
                        ...pre,
                        { kind: "if", cond: elifCond, then: this.lowerBlock(elif.block), else: elseStmt },
                    ];
                }

                out.push({
                    kind: "if",
                    cond,
                    then: this.lowerBlock(node.thenBlock),
                    else: elseStmt,
                });
                break;
            }
            case "WhileStatement": {
                const cond = this.lowerExpr(node.condition, out);
                out.push({ kind: "while", cond, body: this.lowerBlock(node.body) });
                break;
            }
            case "ReturnStatement": { // TODO: impl the other forms of return statements
                if (!node.argument) break;
                
                const plan = this.currentPlan!;
                
                const values = node.argument.type === "TupleExpression" ? node.argument.elements : [node.argument];
                
                for (let i = 0; i < values.length; i ++) {
                    const expr = values[i];
                    
                    let opcode;
                    let var_name;
                    if (plan.strategy === "var") {
                        opcode = "data_setvariableto";
                        var_name = plan.retVars[i];
                    } else if (plan.strategy === "vstack") {
                        opcode = "data_addtolist";
                        var_name = plan.vStackName!;
                    } else {
                        break;
                    }
                    
                    out.push({
                        kind: "raw",
                        opcode,
                        inputs: [
                            { kind: "var", name: var_name },
                            this.lowerExpr(expr, out)
                        ]
                    });
                }

                out.push({
                    kind: "raw",
                    opcode: "control_stop",
                    inputs: [
                        { kind: "lit", value: "this script" }
                    ]
                });
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

            case "Identifier": {
                const operand = this.substitutions?.get(node.name);
                if (operand) return operand;
                // TODO: needs analyzer.identBindings to tell param from var from enum member
                return { kind: "var", name: node.name };
            }

            case "UnaryExpression": {
                const arg = this.lowerExpr(node.argument, out);
                if (node.operator === "!") return { kind: "op", opcode: "operator_not", inputs: [arg] };
                return { kind: "op", opcode: "operator_subtract", inputs: [{ kind: "lit", value: 0 }, arg] };
            }

            case "BinaryExpression": {
                const left = this.lowerExpr(node.left, out);
                const right = this.lowerExpr(node.right, out);
                // TODO: `+` over str operands is operator_join, not operator_add- needs analyzer.exprTypes
                const opcode = binaryOpcodes[node.operator];
                if (opcode) return { kind: "op", opcode, inputs: [left, right] };

                const composed = this.operatorProcs.get(node.operator);
                if (composed) return this.inlineBuilds(composed, [left, right], out);
                return { kind: "lit", value: "" }; // TODO: **, % over non-num; no opcode and no builds proc
            }
            case "CallExpression": {
                const sig = this.analyzer.callResolutions.get(node)!;
                const args = sig.params.map((param, i) => {
                    return this.lowerExpr((node.arguments[i] ?? param.default!) as ExpressionNode, out);
                });

                if (sig.meta?.lower === "reporter") return { kind: "op", opcode: sig.meta.opcode!, inputs: args };
                if (sig.meta?.lower === "builds") return this.inlineBuilds(sig, args, out);

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
                        return { kind: "stackref", list: plan.vStackName!, depth: 0 }
                    }
                }
            }

            // TODO: InterpolatedString (nested operator_join),
            // MemberExpression, IndexerAccess, SliceAccess
        }
        return { kind: "lit", value: "" };
    }

    /**
     * Inlines a @lower = "builds" proc: lowers its `return` expression into one nested reporter tree.
     * Keeps the result usable in boolean slots, which a proc call's ret var would not be.
     */
    private inlineBuilds(sig: Signature, args: IRExpr[], out: IRStmt[]): IRExpr {
        const saved = this.substitutions;
        this.substitutions = new Map(sig.params.map((param, i) => [param.name, args[i]]));
        const result = this.lowerExpr(sig.meta!.buildsExpr!, out);
        this.substitutions = saved;
        return result;
    }
}

/** Scratch inputs are only %n, %s, %b; num -> NUMBER, bool -> BOOLEAN, everything else -> STRING. */
function paramTypeOf(type: TypeNode): paramType {
    if (type.type !== "Type") return paramType.STRING;
    if (type.typeName === "num") return paramType.NUMBER;
    if (type.typeName === "bool") return paramType.BOOLEAN;
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
    // <=, >=, !&, !|, !^ and ^ have no opcode: they come from the @lower = "builds" procs
    // TODO: impl **
}