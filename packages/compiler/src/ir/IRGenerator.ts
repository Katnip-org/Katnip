/**
 * @fileoverview Lowers the analyzed AST into IR. Runs after SemanticAnalyzer, and assumes no errors were reported.
 *
 * The core rule from IRNode: no IRExpr may contain a value-returning call. Every expression lowering therefore takes a
 * statement sink; anything needing setup blocks pushes them into the sink and returns an IRExpr naming the result.
 */

import type {
    AST,
    BlockNode,
    CallExpressionNode,
    ExpressionNode,
    ForStatementNode,
    ProcedureDeclarationNode,
    SpriteDeclarationNode,
    StatementNode,
    TypeNode,
    VariableDeclarationNode,
} from "../parser/AST-nodes.js";
import type { SemanticAnalyzer } from "../semantic/SemanticAnalyzer.js";
import { KatnipError } from "../utils/ErrorReporter.js";
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

type StackRef = Extract<IRExpr, { kind: "stackref" }>;

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
        lists: new Map([["_GtempKeys", []], ["_GtempVals", []]]),
    };

    private sprite: IRSprite | null = null;

    private readonly plans = new Map<Signature, ReturnPlan>();
    private readonly usedNames = new Set<string>();
    private currentPlan: ReturnPlan | null = null;

    /** Binary operators with no Scratch block, mapped to the @lower = "builds" proc that composes them. */
    private readonly operatorProcs = new Map<string, Signature>();
    /** Param name -> operand, while inlining a "builds" body. */
    private substitutions: Map<string, IRExpr> | null = null;

    /** Params of the proc being lowered. */
    private params = new Set<string>();
    /** Local name => mangled global. */
    private temps = new Map<string, string>();

    /** Vstack slots pushed and not yet popped: one list name per slot, in push order. */
    private readonly pending: string[] = [];

    /** Declared list/dict name => the sb3 list(s) backing it: [list], or [keys, vals] for a dict. */
    private readonly listNames = new Map<string, string[]>();

    /** Top-level variable names, so a sprite member that shadows one can be renamed. */
    private globalNames = new Set<string>();
    /** Source name => sb3 name, for sprite members renamed to clear a global. Cleared per sprite. */
    private renamed = new Map<string, string>();
    /** Contents that need blocks: top-level lists, and the current sprite's lists. */
    private readonly init: IRStmt[] = [];
    private spriteInit: IRStmt[] = [];

    constructor(private analyzer: SemanticAnalyzer) {}

    generate(ast: AST): IRProgram {
        this.planReturns();
        // Collected before any sprite is lowered, because a sprite may be declared ahead of the
        // global it shadows and its members still have to be renamed clear of it.
        this.globalNames = new Set(
            ast.body.filter((stmt) => stmt.type === "VariableDeclaration").map((stmt) => stmt.name),
        );
        for (const stmt of ast.body) {
            switch (stmt.type) {
                case "SpriteDeclaration":
                    this.lowerSprite(stmt);
                    break;
                case "VariableDeclaration":
                    this.declareMember(stmt);
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
        // Scratch has no load hook, so list contents that need blocks are built by a green-flag script.
        // It goes in the first sprite, ahead of that sprite's own scripts so its lists are ready for them.
        if (this.init.length && this.program.sprites[0])
            this.program.sprites[0].scripts.unshift({
                hatOpcode: "event_whenflagclicked",
                args: [],
                body: this.init,
            });
        return this.program;
    }

    private lowerSprite(node: SpriteDeclarationNode): void {
        this.sprite = {
            name: node.name,
            scripts: [],
            variables: [],
            lists: new Map([["_tempKeys", []], ["_tempVals", []]]),
            procs: new Map(),
        };
        this.program.sprites.push(this.sprite);
        this.spriteInit = [];
        this.renamed = new Map();

        // Members first: a handler may be written above the member it reads, and lowering one needs
        // the member's sb3 name and backing lists to be known already.
        for (const stmt of node.body.body)
            if (stmt.type === "VariableDeclaration") this.declareMember(stmt);

        for (const stmt of node.body.body) {
            switch (stmt.type) {
                case "HandlerStatement": {
                    const out: IRStmt[] = [];
                    const sig = this.analyzer.callResolutions.get(stmt.call);
                    this.sprite.scripts.push({
                        hatOpcode: sig?.meta?.opcode ?? "",
                        // TODO: hat args must be literals
                        args: sig ? this.callArgs(stmt.call, sig).map((arg) => this.lowerExpr(arg, out)) : [],
                        body: this.lowerBlock(stmt.body),
                    });
                    break;
                }
                case "ProcedureDeclaration": {
                    const proc = this.lowerProc(stmt);
                    if (proc) this.sprite.procs.set(stmt.name, proc);
                    break;
                }
            }
        }

        if (this.spriteInit.length)
            this.sprite.scripts.unshift({ hatOpcode: "event_whenflagclicked", args: [], body: this.spriteInit });
        this.sprite = null;
    }

    private declareMember(node: VariableDeclarationNode): void {
        const target = this.sprite ?? this.program;
        const kind =
            node.varType?.type === "Type"
                ? node.varType.typeName
                : node.initializer && this.analyzer.exprTypes.get(node.initializer)?.kind;
        const init = node.initializer;

        const name = this.emittedName(node.name);

        if (kind !== "list" && kind !== "dict") {
            target.variables.push(name); // TODO: unmangled; mangle once procs land
            return;
        }

        const entries = init?.type === "DictExpression" ? init.entries : [];
        const columns: [string, ExpressionNode[]][] =
            kind === "list"
                ? [[name, init?.type === "ListExpression" ? init.elements : []]]
                : [
                      [`${name}_keys`, entries.map((entry) => entry.key)],
                      [`${name}_vals`, entries.map((entry) => entry.value)],
                  ];
        this.listNames.set(node.name, columns.map(([column]) => column));

        const baked = columns.map(([, elements]) => literals(elements));
        const runtime = baked.some((values) => values === null);

        const out = this.sprite ? this.spriteInit : this.init;
        const mark = this.pending.length;
        columns.forEach(([name, elements], i) => {
            target.lists.set(name, runtime ? [] : baked[i]!);
            if (!runtime) return;

            this.emit(out, { kind: "raw", opcode: "data_deletealloflist", inputs: [{ kind: "var", name }] });
            for (const element of elements)
                this.emit(out, {
                    kind: "raw",
                    opcode: "data_addtolist",
                    inputs: [{ kind: "var", name }, this.lowerExpr(element, out)],
                });
        });
        this.popTo(out, mark);
    }


    private listsOf(node: ExpressionNode): string[] {
        const names = node.type === "Identifier" ? this.listNames.get(node.name) : undefined;
        if (!names)
            throw new KatnipError(
                "IR",
                `only a declared list or dict can be indexed, got ${node.type === "Identifier" ? `'${node.name}'` : node.type}`,
                {
                    line: node.loc.start.line,
                    column: node.loc.start.column,
                    endLine: node.loc.end.line,
                    endColumn: node.loc.end.column,
                },
            );
        return names;
    }

    private callArgs(call: CallExpressionNode, sig: Signature): ExpressionNode[] {
        const named = new Map<string, ExpressionNode>();
        const positional: ExpressionNode[] = [];
        for (const arg of call.arguments) {
            if (arg.type === "NamedArgument") named.set(arg.name, arg.value);
            else positional.push(arg);
        }
        if (sig.params[0]?.name === "self" && call.object.type === "MemberExpression")
            positional.unshift(call.object.object);

        return sig.params.map((param, i) => named.get(param.name) ?? positional[i] ?? param.default!);
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

        if (plan.vStackName) (this.sprite ?? this.program).lists.set(plan.vStackName, []);
        (this.sprite ?? this.program).variables.push(...plan.retVars);

        const params: IRParam[] = stmt.parameters.map((param) => ({
            name: param.name,
            type: paramTypeOf(param.paramType),
        }));

        this.currentPlan = plan;
        this.params = new Set(params.map((param) => param.name));
        this.temps = new Map();
        const body = this.lowerBlock(stmt.body);
        const temps = [...this.temps.values()];
        (this.sprite ?? this.program).variables.push(...temps);
        this.currentPlan = null;
        this.params = new Set();
        this.temps = new Map();

        return {
            name: plan.mangled,
            params,
            returns: plan.returns,
            warp: sig.meta?.warp ?? true,
            strategy: plan.strategy,
            vStackName: plan.vStackName,
            retVars: plan.retVars,
            temps,
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
        const mark = this.pending.length;
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

                this.emit(out, {
                    kind: "if",
                    cond,
                    then: this.lowerBlock(node.thenBlock),
                    else: elseStmt,
                });
                break;
            }
            case "WhileStatement": {
                const cond = this.lowerExpr(node.condition, out);
                this.emit(out, { kind: "while", cond, body: this.lowerBlock(node.body) });
                break;
            }
            case "DoWhileStatement": {
                out.push(...this.lowerBlock(node.body));
                const cond = this.lowerExpr(node.condition, out);
                this.emit(out, { kind: "while", cond, body: this.lowerBlock(node.body) });
                break;
            }
            case "ForStatement": {
                this.lowerFor(node, out);
                break;
            }
            case "SwitchDeclaration": {
                const value = this.lowerExpr(node.value, out);
                let chain: IRStmt[] = [];
                for (let idx = node.body.length - 1; idx >= 0; idx--) {
                    const clause = node.body[idx];
                    if (clause.type === "DefaultCaseDeclaration") {
                        chain = this.lowerBlock(clause.body);
                        continue;
                    }
                    const pre: IRStmt[] = [];
                    const cond = clause.values
                        .map(
                            (test): IRExpr => ({
                                kind: "op",
                                opcode: "operator_equals",
                                inputs: [structuredClone(value), this.lowerExpr(test, pre)],
                            }),
                        )
                        .reduce((left, right) => ({ kind: "op", opcode: "operator_or", inputs: [left, right] }));
                    chain = [...pre, { kind: "if", cond, then: this.lowerBlock(clause.body), else: chain }];
                }
                for (const stmt of chain) this.emit(out, stmt);
                break;
            }
            case "ReturnStatement": {
                const plan = this.currentPlan!;
                const values =
                    node.argument === null
                        ? []
                        : node.argument.type === "TupleExpression"
                          ? node.argument.elements
                          : [node.argument];
                const lowered = values.map((expr) => this.lowerExpr(expr, out));

                if (plan.strategy === "var")
                    lowered.forEach((value, i) => this.emit(out, this.set(plan.retVars[i], value)));
                else if (plan.strategy === "vstack") {
                    let staged;
                    if (this.pending.length > mark) {
                        staged = lowered.map((value, i) => {
                              const name = this.declare(`staged${i}`);
                              this.emit(out, this.set(name, value));
                              return { kind: "var", name } as IRExpr;
                          })
                    } else {
                        staged = lowered;
                    }
                    this.popTo(out, mark);
                    for (const value of staged)
                        this.emit(out, {
                            kind: "raw",
                            opcode: "data_addtolist",
                            inputs: [{ kind: "var", name: plan.vStackName! }, value],
                        });
                }

                this.popTo(out, mark);
                out.push({ kind: "raw", opcode: "control_stop", inputs: [{ kind: "lit", value: "this script" }] });
                break;
            }
            case "VariableAssignment": {
                if (node.left.type === "IndexerAccess") {
                    const lists = this.listsOf(node.left.object);
                    const index = this.lowerExpr(node.left.index, out);
                    const right = this.lowerExpr(node.right, out);
                    const keys: IRExpr = { kind: "var", name: lists[0] };
                    const vals: IRExpr = { kind: "var", name: lists[lists.length - 1] };

                    const slot = (): IRExpr =>
                        lists.length === 1
                            ? structuredClone(index)
                            : {
                                  kind: "op",
                                  opcode: "data_itemnumoflist",
                                  inputs: [structuredClone(keys), structuredClone(index)],
                              };
                    const value = (): IRExpr =>
                        node.operator === "="
                            ? structuredClone(right)
                            : {
                                  kind: "op",
                                  opcode: binaryOpcodes[node.operator.slice(0, -1)],
                                  inputs: [
                                      { kind: "op", opcode: "data_itemoflist", inputs: [structuredClone(vals), slot()] },
                                      structuredClone(right),
                                  ],
                              };

                    const replace: IRStmt = {
                        kind: "raw",
                        opcode: "data_replaceitemoflist",
                        inputs: [structuredClone(vals), slot(), value()],
                    };
                    if (lists.length === 1) {
                        this.emit(out, replace);
                        break;
                    }
                    
                    this.emit(out, {
                        kind: "if",
                        cond: { kind: "op", opcode: "operator_gt", inputs: [slot(), { kind: "lit", value: 0 }] },
                        then: [replace],
                        else: [
                            {
                                kind: "raw",
                                opcode: "data_addtolist",
                                inputs: [structuredClone(keys), structuredClone(index)],
                            },
                            { kind: "raw", opcode: "data_addtolist", inputs: [structuredClone(vals), value()] },
                        ],
                    });
                    break;
                }
                if (node.left.type !== "Identifier") break; // TODO: member -> struct write
                const value: IRExpr =
                    node.operator === "="
                        ? this.lowerExpr(node.right, out)
                        : {
                              kind: "op",
                              opcode: binaryOpcodes[node.operator.slice(0, -1)],
                              inputs: [this.lowerExpr(node.left, out), this.lowerExpr(node.right, out)],
                          };
                this.emit(out, this.set(this.local(node.left.name), value));
                break;
            }
            case "VariableDeclaration": {
                const init = node.initializer ? this.lowerExpr(node.initializer, out) : null;
                this.emit(out, this.set(this.declare(node.name), init ?? { kind: "lit", value: "" }));
                break;
            }
            case "ExpressionStatement": {
                const expr = node.expression;
                if (expr.type === "CallExpression") {
                    const sig = this.analyzer.callResolutions.get(expr);
                    if (sig?.meta?.lower === "command") {
                        const args = this.callArgs(expr, sig).map((arg) => this.lowerExpr(arg, out));
                        this.emit(out, { kind: "raw", opcode: sig.meta.opcode!, inputs: args });
                        break;
                    }
                }
                this.lowerExpr(node.expression, out);
                // `lowerExpr()` will automatically parse a userproc call and emit it;
                // we ignore the return if its anything else (reporter/yields), as it shouldn't be here
                break;
            }
        }
        this.popTo(out, mark);
    }

    /** num => counter, list/str/dict => index. */
    private lowerFor(node: ForStatementNode, out: IRStmt[]): void {
        const type = this.analyzer.exprTypes.get(node.iterable);

        if (type?.kind === "dict") {
            const lists = this.listsOf(node.iterable);
            const parts = node.pattern.type === "TupleExpression" ? node.pattern.elements : [node.pattern];
            const names = parts.map((part) => (part.type === "Identifier" ? part.name : null));
            if (names.length > 2 || names.some((name) => name === null)) return; // TODO: error

            const iter = this.declare(names[0]!);
            const item = (list: string): IRExpr => ({
                kind: "op",
                opcode: "data_itemoflist",
                inputs: [{ kind: "var", name: list }, { kind: "var", name: iter }],
            });
            
            const step: IRStmt[] = [];
            if (names[1]) step.push(this.set(this.declare(names[1]), item(lists[1])));
            step.push(this.set(iter, item(lists[0])));

            this.emit(out, {
                kind: "for",
                iter,
                times: { kind: "op", opcode: "data_lengthoflist", inputs: [{ kind: "var", name: lists[0] }] },
                body: [...step, ...this.lowerBlock(node.body)],
            });
            return;
        }

        if (node.pattern.type !== "Identifier") return; // TODO: destructuring a non-dict
        if (this.lowerForRange(node, out)) return;
        const iterable = this.lowerExpr(node.iterable, out);
        const name = this.declare(node.pattern.name);

        if (type?.kind === "primitive" && type.name === "num") {
            this.emit(out, { kind: "for", iter: name, times: iterable, body: this.lowerBlock(node.body) });
            return;
        }
        const isList = type?.kind === "list";
        if (!isList && !(type?.kind === "primitive" && type.name === "str")) return; // TODO: dict iteration

        const index: IRExpr = { kind: "var", name };
        let element: IRExpr;
        if (isList) {
            element = { kind: "op", opcode: "data_itemoflist", inputs: [iterable, index] };
        } else {
            element = { kind: "op", opcode: "operator_letter_of", inputs: [index, iterable] };
        }
        
        const times: IRExpr = {
            kind: "op",
            opcode: isList ? "data_lengthoflist" : "operator_length",
            inputs: [structuredClone(iterable)],
        };
        const step: IRStmt = this.set(name, element);
        this.emit(out, { kind: "for", iter: name, times, body: [step, ...this.lowerBlock(node.body)] });
    }

    /**
     * `for (x, range(start, stop, step))` becomes: `for (x, ceil((stop-start)/step)`
     * Remaps the 1-based counter with `x = i * step + (start - step)`.
     * Returns false if the iterable isn't a range() call.
     */
    private lowerForRange(node: ForStatementNode, out: IRStmt[]): boolean {
        const call = node.iterable;
        if (call.type !== "CallExpression") return false;
        const sig = this.analyzer.callResolutions.get(call);
        if (sig?.meta?.opcode !== "katnip_range") return false;

        const resolved = this.callArgs(call, sig);
        const arg = (want: string): IRExpr | null => {
            const i = sig.params.findIndex((p) => p.name === want);
            if (i < 0 || !resolved[i]) return null;
            return this.lowerExpr(resolved[i]!, out);
        };
        const start = arg("start") ?? { kind: "lit", value: 0 };
        const stop = arg("stop")!;
        const step = arg("step") ?? { kind: "lit", value: 1 };

        /** The numeric value of a literal expr, or null if it isn't one. Drives the constant folding below. */
        const num = (expr: IRExpr): number | null => {
            if (expr.kind !== "lit") return null;
            const n = Number(expr.value);
            return Number.isFinite(n) ? n : null;
        };
        const [a, b, c] = [num(start), num(stop), num(step)];

        let times: IRExpr;
        if (a !== null && b !== null && c !== null) {
            times = { kind: "lit", value: Math.ceil((b - a) / c) };
        } else {
            const span: IRExpr = a === 0 ? stop : { kind: "op", opcode: "operator_subtract", inputs: [stop, start] };
            const div: IRExpr = c === 1 ? span : { kind: "op", opcode: "operator_divide", inputs: [span, step] };
            times = { kind: "op", opcode: "operator_mathop", inputs: [{ kind: "lit", value: "ceiling" }, div] };
        }

        const iter = this.declare((node.pattern as { name: string }).name);
        let value: IRExpr = { kind: "var", name: iter };
        if (c !== 1) value = { kind: "op", opcode: "operator_multiply", inputs: [value, step] };
        
        let offset: IRExpr;
        if (a !== null && c !== null) {
            offset = { kind: "lit", value: a - c };
        } else {
            offset = { kind: "op", opcode: "operator_subtract", inputs: [start, step] };
        }

        if (num(offset) !== 0) value = { kind: "op", opcode: "operator_add", inputs: [value, offset] };

        this.emit(out, {
            kind: "for",
            iter,
            times,
            body: [...(value.kind === "var" ? [] : [this.set(iter, value)]), ...this.lowerBlock(node.body)],
        });
        return true;
    }

    /** Registers a proc-local, mangled globally. Script-scope temps keep their name and are owned by the sprite. */
    private declare(name: string): string {
        if (!this.currentPlan) {
            const scope = (this.sprite ?? this.program).variables;
            if (!scope.includes(name)) scope.push(name);
            return name;
        }
        const existing = this.temps.get(name);
        if (existing) return existing;
        const mangled = this.mangle(`${this.currentPlan.mangled}_${name}`);
        this.temps.set(name, mangled);
        return mangled;
    }

    private local(name: string): string {
        return this.temps.get(name) ?? this.renamed.get(name) ?? name;
    }

    /**
     * The sb3 name for a declared member: its own, unless it is a sprite member colliding with a
     * global, which Scratch cannot represent. Prefixing with the sprite keeps both readable.
     */
    private emittedName(name: string): string {
        if (!this.sprite || !this.globalNames.has(name)) return name;
        const renamed = `${this.sprite.name}_${name}`;
        this.renamed.set(name, renamed);
        return renamed;
    }

    private depthOf(list: string): number {
        return this.pending.reduce((count, pushed) => count + (pushed === list ? 1 : 0), 0);
    }

    /** Pushes width slots, deepest ref first. */
    private pushVstack(list: string, width: number): StackRef[] {
        return Array.from({ length: width }, () => {
            const ref: StackRef = { kind: "stackref", list, depth: 0, offset: this.depthOf(list) };
            this.pending.push(list);
            return ref;
        });
    }

    private set(name: string, value: IRExpr): IRStmt {
        return { kind: "raw", opcode: "data_setvariableto", inputs: [{ kind: "var", name }, value] };
    }

    private popTo(out: IRStmt[], mark: number): void {
        while (this.pending.length > mark)
            out.push({
                kind: "raw",
                opcode: "data_deleteoflist",
                inputs: [{ kind: "var", name: this.pending.pop()! }, { kind: "lit", value: "last" }],
            });
    }

    private emit(out: IRStmt[], stmt: IRStmt): void {
        this.freeze(stmt);
        out.push(stmt);
    }

    private freeze(node: unknown): void {
        if (node === null || typeof node !== "object") return;
        const ref = node as StackRef;
        if (ref.kind === "stackref" && ref.offset !== undefined) {
            ref.depth = this.depthOf(ref.list) - 1 - ref.offset;
            delete ref.offset;
        }
        for (const value of Object.values(node)) this.freeze(value);
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
                if (this.params.has(node.name)) return { kind: "param", name: node.name };
                return { kind: "var", name: this.local(node.name) };
            }

            case "UnaryExpression": {
                const arg = this.lowerExpr(node.argument, out);
                if (node.operator === "!") return { kind: "op", opcode: "operator_not", inputs: [arg] };
                return { kind: "op", opcode: "operator_subtract", inputs: [{ kind: "lit", value: 0 }, arg] };
            }

            case "BinaryExpression": {
                const left = this.lowerExpr(node.left, out);
                const right = this.lowerExpr(node.right, out);
                const type = this.analyzer.exprTypes.get(node);
                if (node.operator === "+" && type?.kind === "primitive" && type.name === "str")
                    return { kind: "op", opcode: "operator_join", inputs: [left, right] };

                const opcode = binaryOpcodes[node.operator];
                if (opcode) return { kind: "op", opcode, inputs: [left, right] };

                const composed = this.operatorProcs.get(node.operator);
                if (composed) return this.inlineBuilds(composed, [left, right], out);
                return { kind: "lit", value: "" }; // TODO: **, % over non-num; no opcode and no builds proc
            }
            case "CallExpression": {
                const sig = this.analyzer.callResolutions.get(node);
                if (!sig) break; // TODO: struct literal, the one call the analyzer resolves to no signature
                const args = this.callArgs(node, sig).map((arg) => this.lowerExpr(arg, out));

                if (sig.meta?.lower === "reporter") return { kind: "op", opcode: sig.meta.opcode!, inputs: args };
                if (sig.meta?.lower === "builds") return this.inlineBuilds(sig, args, out);

                const plan = this.plans.get(sig)!;
                this.emit(out, { kind: "call", proc: plan.mangled, args });
                if (!plan.strategy) break;

                // expression slot => first element
                const width = plan.returns.kind === "tuple" ? plan.returns.width : 1;
                if (plan.strategy === "var") return { kind: "var", name: plan.retVars[0] };
                return this.pushVstack(plan.vStackName!, width)[0];
            }
            case "InterpolatedString": {
                // lexer pads holes with ""
                const chunks: IRExpr[] = node.parts
                    .filter((part) => part !== "")
                    .map((part) =>
                        typeof part === "string" ? { kind: "lit", value: part } : this.lowerExpr(part, out),
                    );
                if (chunks.length === 0) return { kind: "lit", value: "" };
                return chunks.reduceRight((right, left) => ({
                    kind: "op",
                    opcode: "operator_join",
                    inputs: [left, right],
                }));
            }
            case "IndexerAccess": {
                const index = this.lowerExpr(node.index, out);
                const type = this.analyzer.exprTypes.get(node.object);
                if (type?.kind === "primitive" && type.name !== "void")
                    return {
                        kind: "op",
                        opcode: "operator_letter_of",
                        inputs: [index, this.lowerExpr(node.object, out)],
                    };

                const lists = this.listsOf(node.object);
                const at: IRExpr =
                    lists.length === 1
                        ? index
                        : {
                              kind: "op",
                              opcode: "data_itemnumoflist",
                              inputs: [{ kind: "var", name: lists[0] }, index],
                          };
                return {
                    kind: "op",
                    opcode: "data_itemoflist",
                    inputs: [{ kind: "var", name: lists[lists.length - 1] }, at],
                };
            }
            case "MemberExpression": {
                // Enum members and namespace constants are compile-time values, folded by the analyzer.
                if (node.object.type === "Identifier") {
                    const value = this.analyzer.constMembers.get(`${node.object.name}.${node.property.name}`);
                    if (value !== undefined) return { kind: "lit", value };
                }
                break; // TODO: struct field read
            }
            // TODO: SliceAccess
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

/** Initial list contents, or null when an element needs blocks to build and the column must be filled at runtime. */
function literals(nodes: ExpressionNode[]): (string | number | boolean)[] | null {
    const values: (string | number | boolean)[] = [];
    for (const node of nodes) {
        if (node.type !== "Literal") return null;
        values.push(node.value ?? "");
    }
    return values;
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