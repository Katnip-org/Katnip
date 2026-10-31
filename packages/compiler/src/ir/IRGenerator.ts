/**
 * @fileoverview Lowers the analyzed AST into IR. Runs after SemanticAnalyzer, and assumes no errors were reported.
 *
 * The core rule from IRNode: no IRExpr may contain a value-returning call. Every expression lowering therefore takes a
 * statement sink; anything needing setup blocks pushes them into the sink and returns an IRExpr naming the result.
 */

import { isPublicVar } from "../parser/AST-nodes.js";
import type {
    AST,
    BlockNode,
    CallExpressionNode,
    ExpressionNode,
    ForStatementNode,
    ProcedureDeclarationNode,
    SliceAccessNode,
    SourceLocation,
    SpriteDeclarationNode,
    StatementNode,
    StructFieldNode,
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
        variables: new Map(),
        lists: new Map(),
    };

    private sprite: IRSprite | null = null;

    private readonly plans = new Map<Signature, ReturnPlan>();
    private readonly lowered = new Set<ProcedureDeclarationNode>();
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

    /** Return variables this statement read, which a later call in the statement would overwrite. */
    private liveRets: Extract<IRExpr, { kind: "var" }>[] = [];
    private stagedRets = 0;
    /** Sliced lists are filled by a generated warp proc, per owner, source and destination. */
    private readonly sliceProcs = new Set<string>();
    private sliceLists = 0;
    /** Stdlib userprocs a call has reached; the rest stay out of the project. */
    private readonly usedStdlib = new Set<Signature>();

    /** Vstack slots pushed and not yet popped: one list name per slot, in push order. */
    private readonly pending: string[] = [];

    /** Declared list/dict name => the sb3 list(s) backing it: [list], or [keys, vals] for a dict. */
    private listNames = new Map<string, string[]>();

    /** Struct name => its fields, in declaration order. */
    private readonly structs = new Map<string, StructFieldNode[]>();
    /** Struct-typed name => one sb3 variable (or param) per field, in field order. */
    private structVars = new Map<string, string[]>();
    /** list<Struct> name => one parallel sb3 list per field, kept in lockstep. */
    private structLists = new Map<string, string[]>();

    /** Top-level variable names, so a sprite member that shadows one can be renamed. */
    private globalNames = new Set<string>();
    /** Source name => sb3 name, for sprite members renamed to clear a global. Cleared per sprite. */
    private renamed = new Map<string, string>();
    /** Contents that need blocks: top-level lists, and the current sprite's lists. */
    private readonly init: IRStmt[] = [];
    private spriteInit: IRStmt[] = [];

    constructor(private analyzer: SemanticAnalyzer) {}

    generate(ast: AST): IRProgram {
        for (const stmt of ast.body) if (stmt.type === "StructDeclaration") this.structs.set(stmt.name, stmt.fields);
        this.planReturns();
        // Collected before any sprite is lowered, because a sprite may be declared ahead of the
        // global it shadows and its members still have to be renamed clear of it.
        this.globalNames = new Set(
            ast.body.flatMap((stmt) =>
                stmt.type === "VariableDeclaration"
                    ? [stmt.name]
                    : stmt.type === "SpriteDeclaration"
                      ? stmt.body.body.filter(isPublicVar).map((member) => member.name)
                      : [],
            ),
        );
        // Same reason: a sprite can index a global list declared below it
        for (const stmt of ast.body) if (stmt.type === "VariableDeclaration") this.declareMember(stmt);

        for (const stmt of ast.body) {
            switch (stmt.type) {
                case "SpriteDeclaration":
                    this.lowerSprite(stmt);
                    break;
                case "VariableDeclaration":
                    break;
                case "ProcedureDeclaration": {
                    const proc = this.lowerProc(stmt);
                    if (proc) this.program.procs.set(proc.name, proc);
                    break;
                }
                case "EnumDeclaration":
                case "ImportDeclaration":
                case "StructDeclaration":
                    break;
                case "VariableAssignment":
                case "HandlerStatement":
                case "SwitchDeclaration":
                case "ExpressionStatement":
                case "IfStatement":
                case "WhileStatement":
                case "DoWhileStatement":
                case "ForeverStatement":
                case "RepeatStatement":
                case "ForStatement":
                case "ReturnStatement":
                    throw new KatnipError("IR", "this statement isn't allowed at the top level; put it inside an event handler", spanOf(stmt));
                case "ErrorStatement":
                    break;
            }
        }

        for (const [decl, sig] of this.analyzer.procSignatures) {
            if (!this.plans.has(sig) || (sig.meta?.stdlib && !this.usedStdlib.has(sig))) continue;
            const proc = this.lowerProc(decl);
            if (proc) this.program.procs.set(proc.name, proc);
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
            costumes: [],
            sounds: [],
            scripts: [],
            variables: new Map(),
            lists: new Map(),
            procs: new Map(),
        };
        this.program.sprites.push(this.sprite);
        this.spriteInit = [];
        this.renamed = new Map();
        const listNames = new Map(this.listNames);
        const structVars = new Map(this.structVars);
        const structLists = new Map(this.structLists);

        // Members first: a handler may be written above the member it reads, and lowering one needs
        // the member's sb3 name and backing lists to be known already.
        for (const stmt of node.body.body)
            if (stmt.type === "VariableDeclaration") this.declareMember(stmt);

        for (const stmt of node.body.body) {
            switch (stmt.type) {
                case "HandlerStatement": {
                    const out: IRStmt[] = [];
                    const sig = this.analyzer.callResolutions.get(stmt.call);
                    // TODO: hat args must be literals
                    const args = sig ? this.callArgs(stmt.call, sig).map((arg) => this.lowerExpr(arg, out)) : [];
                    // A hat has nowhere to run setup blocks before it fires
                    if (out.length)
                        throw new KatnipError("IR", "a hat argument cannot call a procedure", spanOf(stmt.call));
                    this.sprite.scripts.push({
                        hatOpcode: sig?.meta?.opcode ?? "",
                        args,
                        body: this.lowerBlock(stmt.body),
                    });
                    break;
                }
                case "ProcedureDeclaration": {
                    const proc = this.lowerProc(stmt);
                    if (proc) this.sprite.procs.set(stmt.name, proc);
                    break;
                }
                case "AssetDeclaration": {
                    // Default name is the file stem, like an import's default namespace.
                    const name = stmt.alias ?? stmt.specifier.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, "");
                    (stmt.kind === "costume" ? this.sprite.costumes : this.sprite.sounds).push({ name, path: stmt.specifier });
                    break;
                }
                case "VariableDeclaration":
                case "ErrorStatement":
                    break;
                default:
                    throw new KatnipError("IR", "this statement isn't allowed directly in a sprite; put it inside an event handler", spanOf(stmt));
            }
        }

        if (this.spriteInit.length)
            this.sprite.scripts.unshift({ hatOpcode: "event_whenflagclicked", args: [], body: this.spriteInit });
        this.sprite = null;
        this.renamed = new Map();
        this.listNames = listNames;
        this.structVars = structVars;
        this.structLists = structLists;
    }

    private declareMember(node: VariableDeclarationNode, sink?: IRStmt[]): void {
        const target = isPublicVar(node) ? this.program : this.sprite ?? this.program;
        const init = node.initializer;
        if (!sink) this.liveRets = [];
        const struct = this.declaredStruct(node);
        if (struct) {
            this.declareStruct(node, struct.name, struct.list, target, sink);
            return;
        }
        const kind =
            node.varType?.type === "Type"
                ? node.varType.typeName
                : init && this.analyzer.exprTypes.get(init)?.kind;
        const name = this.emittedName(node);

        if (kind !== "list" && kind !== "dict") {
            if (!sink) {
                // TODO: unmangled; mangle once procs land
                const baked = init ? literals([init]) : [""];
                if (baked) {
                    target.variables.set(name, baked[0]);
                } else {
                    target.variables.set(name, "");
                    const out = this.sprite ? this.spriteInit : this.init;
                    const mark = this.pending.length;
                    this.emit(out, this.set(name, this.lowerExpr(init!, out)));
                    this.popTo(out, mark);
                }
                return;
            }
            const value: IRExpr = init ? this.lowerExpr(init, sink) : { kind: "lit", value: "" };
            this.emit(sink, this.set(this.declare(node.name, target), value));
            return;
        }

        const slice = init?.type === "SliceAccess" ? init : null;
        if (init && !slice && init.type !== (kind === "list" ? "ListExpression" : "DictExpression"))
            throw new KatnipError("IR", `a ${kind} can only be initialized from a literal or a slice for now`, spanOf(init));

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
        const runtime = sink !== undefined || slice !== null || baked.some((values) => values === null);

        const out = sink ?? (this.sprite ? this.spriteInit : this.init);
        const mark = this.pending.length;
        columns.forEach(([name, elements], i) => {
            target.lists.set(name, runtime ? [] : baked[i]!);
            if (!runtime || slice) return;

            this.emit(out, { kind: "raw", opcode: "data_deletealloflist", inputs: [{ kind: "var", name }] });
            for (const element of elements)
                this.emit(out, {
                    kind: "raw",
                    opcode: "data_addtolist",
                    inputs: [{ kind: "var", name }, this.lowerExpr(element, out)],
                });
        });
        if (slice) this.assignSlice(columns[0]![0], slice, out);
        this.popTo(out, mark);
    }

    /** The struct a declaration holds, alone or as a list's element. */
    private declaredStruct(node: VariableDeclarationNode): { name: string; list: boolean } | null {
        const type = node.varType;
        if (type?.type === "Type") {
            const element = type.typeName === "list" ? type.typeParams?.[0] : type;
            if (element?.type === "Type" && this.structs.has(element.typeName))
                return { name: element.typeName, list: element !== type };
            return null;
        }
        if (type || !node.initializer) return null;
        const inferred = this.analyzer.exprTypes.get(node.initializer);
        if (inferred?.kind === "struct") return { name: inferred.name, list: false };
        if (inferred?.kind === "list" && inferred.element.kind === "struct")
            return { name: inferred.element.name, list: true };
        return null;
    }

    /** One column per field: plain variables for a lone struct, parallel lists for a list of them. */
    private declareStruct(
        node: VariableDeclarationNode,
        struct: string,
        list: boolean,
        target: IRSprite | IRProgram,
        sink?: IRStmt[],
    ): void {
        const fields = this.structs.get(struct)!;
        const base = this.emittedName(node);
        const init = node.initializer;
        const out = sink ?? (this.sprite ? this.spriteInit : this.init);
        const mark = this.pending.length;

        if (list) {
            const columns = fields.map((field) => `${base}_${field.name}`);
            this.structLists.set(node.name, columns);
            if (init && init.type !== "ListExpression")
                throw new KatnipError("IR", "a list of structs can only be initialized from a literal for now", spanOf(init));
            const elements = init?.type === "ListExpression" ? init.elements : [];
            const baked = elements.map((element) => {
                const row = this.literalFields(element);
                return row ? literals(row) : null;
            });
            if (!sink && baked.every((row) => row !== null)) {
                columns.forEach((column, i) => target.lists.set(column, baked.map((row) => row![i]!)));
                return;
            }
            for (const column of columns) {
                target.lists.set(column, []);
                this.emit(out, { kind: "raw", opcode: "data_deletealloflist", inputs: [{ kind: "var", name: column }] });
            }
            for (const element of elements) {
                const values = this.lowerStruct(element, out);
                columns.forEach((column, i) =>
                    this.emit(out, {
                        kind: "raw",
                        opcode: "data_addtolist",
                        inputs: [{ kind: "var", name: column }, values[i]!],
                    }),
                );
            }
            this.popTo(out, mark);
            return;
        }

        let columns = fields.map((field) => `${base}_${field.name}`);
        if (sink) columns = columns.map((column) => this.declare(column, target));
        this.structVars.set(node.name, columns);

        const nodes = init ? this.literalFields(init) : fields.map((field) => field.default ?? undefined);
        const baked = nodes ? literals(nodes) : null;
        if (!sink && baked) {
            columns.forEach((column, i) => target.variables.set(column, baked[i]!));
            return;
        }
        if (!sink) for (const column of columns) target.variables.set(column, "");
        let values: IRExpr[];
        if (init)
            values = this.lowerStruct(init, out);
        else
            values = nodes!.map((node): IRExpr => (node ? this.lowerExpr(node, out) : { kind: "lit", value: "" }));
        this.assignStruct(columns, values, out);
        this.popTo(out, mark);
    }

    /** A struct literal's field values in field order, defaults filled in; null if `expr` isn't a struct literal. */
    private literalFields(expr: ExpressionNode): (ExpressionNode | undefined)[] | null {
        if (expr.type !== "CallExpression" || expr.object.type !== "Identifier") return null;
        if (this.analyzer.callResolutions.has(expr)) return null;
        const fields = this.structs.get(expr.object.name);
        if (!fields) return null;
        const named = new Map<string, ExpressionNode>();
        for (const arg of expr.arguments) if (arg.type === "NamedArgument") named.set(arg.name, arg.value);
        return fields.map((field) => named.get(field.name) ?? field.default ?? undefined);
    }

    /** Lowers a struct-typed expression to one value per field, in field order. */
    private lowerStruct(expr: ExpressionNode, out: IRStmt[]): IRExpr[] {
        const fields = this.literalFields(expr);
        if (fields) return fields.map((node): IRExpr => (node ? this.lowerExpr(node, out) : { kind: "lit", value: "" }));

        if (expr.type === "Identifier") {
            const columns = this.structVars.get(expr.name);
            if (columns) return columns.map((column) => this.column(column));
        }
        if (expr.type === "IndexerAccess") {
            const columns = this.structListOf(expr.object);
            const index = this.lowerExpr(expr.index, out);
            return columns.map((name) => ({
                kind: "op",
                opcode: "data_itemoflist",
                inputs: [{ kind: "var", name }, structuredClone(index)],
            }));
        }
        if (expr.type === "CallExpression") {
            const sig = this.analyzer.callResolutions.get(expr);
            if (sig) return this.lowerUserproc(expr, sig, this.lowerArgs(expr, sig, out), out);
        }
        throw new KatnipError("IR", "this struct value can't be lowered yet", spanOf(expr));
    }

    /** Writes one value per column; stages first when a value reads a column written before it. */
    private assignStruct(columns: string[], values: IRExpr[], out: IRStmt[]): void {
        const written = new Set(columns);
        // `p = Point(x = p.y, y = p.x)` would otherwise read p_x after overwriting it
        if (values.length > 1 && values.some((value) => mentions(value, written))) {
            values = values.map((value, i): IRExpr => {
                const name = this.declare(`staged${i}`);
                this.emit(out, this.set(name, value));
                return { kind: "var", name };
            });
        }
        columns.forEach((column, i) => this.emit(out, this.set(column, values[i]!)));
    }

    private structListOf(node: ExpressionNode): string[] {
        const columns = node.type === "Identifier" ? this.structLists.get(node.name) : undefined;
        if (!columns) throw new KatnipError("IR", "only a declared list of structs can be indexed here", spanOf(node));
        return columns;
    }

    private fieldIndex(struct: string, field: string): number {
        return this.structs.get(struct)!.findIndex((f) => f.name === field);
    }

    /** The fields of a struct-typed param, or null for any other type. */
    private structFieldsOf(type: TypeNode): StructFieldNode[] | null {
        if (type.type !== "Type") return null;
        return this.structs.get(type.typeName) ?? null;
    }

    private column(name: string): IRExpr {
        if (this.params.has(name)) return { kind: "param", name };
        return { kind: "var", name };
    }

    /** `ps.add(p)`, `ps.length()` and `ps.clear()` on a list of structs act on every column at once. */
    private lowerStructListCall(node: CallExpressionNode, sig: Signature, columns: string[], out: IRStmt[]): IRExpr {
        const opcode = sig.meta?.opcode;
        const list = (name: string): IRExpr => ({ kind: "var", name });
        switch (opcode) {
            case "data_lengthoflist":
                return { kind: "op", opcode, inputs: [list(columns[0]!)] };
            case "data_deletealloflist":
            case "data_showlist":
            case "data_hidelist":
                for (const column of columns) this.emit(out, { kind: "raw", opcode, inputs: [list(column)] });
                return { kind: "lit", value: "" };
            case "data_addtolist": {
                const values = this.lowerStruct(this.callArgs(node, sig)[1]!, out);
                columns.forEach((column, i) => this.emit(out, { kind: "raw", opcode, inputs: [list(column), values[i]!] }));
                return { kind: "lit", value: "" };
            }
        }
        throw new KatnipError("IR", "this list method isn't supported on a list of structs yet", spanOf(node));
    }

    private structListSelf(node: CallExpressionNode, sig: Signature): string[] | null {
        if (sig.params[0]?.name !== "self" || node.object.type !== "MemberExpression") return null;
        const self = node.object.object;
        if (self.type !== "Identifier") return null;
        return this.structLists.get(self.name) ?? null;
    }

    private listsOf(node: ExpressionNode): string[] {
        if (node.type === "MemberExpression") {
            const type = this.analyzer.exprTypes.get(node.object);
            if (type?.kind === "list" && type.element.kind === "struct")
                return [this.structListOf(node.object)[this.fieldIndex(type.element.name, node.property.name)]!];
        }
        const names = node.type === "Identifier" ? this.listNames.get(node.name) : undefined;
        if (!names)
            throw new KatnipError(
                "IR",
                `only a declared list or dict can be indexed, got ${node.type === "Identifier" ? `'${node.name}'` : node.type}`,
                spanOf(node),
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

            const returns = sig.meta.returns ?? { kind: "void" };
            const name = sig.meta.stdlib ? `katnip_${decl.name}` : decl.name;
            this.plans.set(sig, this.planFor(this.mangle(name), returns, sig.meta.retResolved));
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
        if (!plan || this.lowered.has(stmt)) return null;
        this.lowered.add(stmt);

        if (plan.vStackName) (this.sprite ?? this.program).lists.set(plan.vStackName, []);
        for (const name of plan.retVars) (this.sprite ?? this.program).variables.set(name, 0);

        const structVars = new Map(this.structVars);
        // A struct param travels as one Scratch arg per field
        const params: IRParam[] = stmt.parameters.flatMap((param) => {
            const fields = this.structFieldsOf(param.paramType);
            if (!fields) return [{ name: param.name, type: paramTypeOf(param.paramType) }];
            const columns = fields.map((field) => `${param.name}_${field.name}`);
            this.structVars.set(param.name, columns);
            return fields.map((field, i) => ({
                name: columns[i]!,
                type: field.fieldType ? paramTypeOf(field.fieldType) : paramType.STRING,
            }));
        });

        this.currentPlan = plan;
        this.params = new Set(params.map((param) => param.name));
        this.temps = new Map();
        const body = this.lowerBlock(stmt.body);
        const temps = [...this.temps.values()];
        for (const name of temps) (this.sprite ?? this.program).variables.set(name, 0);
        this.currentPlan = null;
        this.params = new Set();
        this.temps = new Map();
        this.structVars = structVars;

        return {
            name: plan.mangled,
            params,
            proccode: sig.meta?.proccode,
            returns: plan.returns,
            warp: sig.meta?.warp ?? true,
            strategy: plan.strategy,
            vStackName: plan.vStackName,
            retVars: plan.retVars,
            temps,
            body,
        };
    }

    private lowerBlock(block: BlockNode): IRStmt[] {
        const out: IRStmt[] = [];
        // A local renamed clear of a global stops shadowing it once its block ends
        const renamed = new Map(this.renamed);
        const listNames = new Map(this.listNames);
        const structVars = new Map(this.structVars);
        const structLists = new Map(this.structLists);
        for (const stmt of block.body) this.lowerStmt(stmt, out);
        this.renamed = renamed;
        this.listNames = listNames;
        this.structVars = structVars;
        this.structLists = structLists;
        return out;
    }

    /** Appends the lowering of one statement to `out`; may append more than one block. */
    private lowerStmt(node: StatementNode, out: IRStmt[]): void {
        const mark = this.pending.length;
        const [liveRets, stagedRets] = [this.liveRets, this.stagedRets];
        this.liveRets = [];
        this.stagedRets = 0;
        switch (node.type) {
            case "IfStatement": {
                const cond = this.lowerExpr(node.condition, out);

                let elseStmt: IRStmt[] = node.elseBlock ? this.lowerBlock(node.elseBlock) : [];

                for (let idx = (node.elifs?.length ?? 0) - 1; idx >= 0; idx--) {
                    const elif = node.elifs![idx];
                    const pre: IRStmt[] = [];
                    const elifMark = this.pending.length;
                    this.liveRets = []; // runs in the else branch, after the condition has been read
                    const elifCond = this.lowerExpr(elif.condition, pre);
                    this.branch(pre, elifMark, elifCond, elif.block, elseStmt);
                    elseStmt = pre;
                }

                this.emit(out, {
                    kind: "if",
                    cond,
                    then: this.lowerBlock(node.thenBlock),
                    else: elseStmt,
                });
                break;
            }
            case "WhileStatement":
            case "DoWhileStatement": {
                if (node.type === "DoWhileStatement") out.push(...this.lowerBlock(node.body));
                const setup = out.length;
                const cond = this.lowerExpr(node.condition, out);
                const body = this.lowerBlock(node.body);
                // The condition's setup has to rerun before every check, not only the first
                if (out.length > setup) {
                    this.popTo(body, mark);
                    // Same temp names as the first lowering, because `cond` is the one read
                    this.liveRets = [];
                    this.stagedRets = 0;
                    this.lowerExpr(node.condition, body);
                }
                this.emit(out, { kind: "while", cond, body });
                break;
            }
            case "ForeverStatement":
                this.emit(out, { kind: "forever", body: this.lowerBlock(node.body) });
                break;
            case "RepeatStatement": {
                const times = this.lowerExpr(node.times, out);
                this.emit(out, { kind: "repeat", times, body: this.lowerBlock(node.body) });
                break;
            }
            case "ForStatement":
                this.lowerFor(node, out);
                break;
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
                    const clauseMark = this.pending.length;
                    this.liveRets = [];
                    const cond = clause.values
                        .map(
                            (test): IRExpr => ({
                                kind: "op",
                                opcode: "operator_equals",
                                inputs: [structuredClone(value), this.lowerExpr(test, pre)],
                            }),
                        )
                        .reduce((left, right) => ({ kind: "op", opcode: "operator_or", inputs: [left, right] }));
                    this.branch(pre, clauseMark, cond, clause.body, chain);
                    chain = pre;
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
                let lowered: IRExpr[];
                if (node.argument && this.analyzer.exprTypes.get(node.argument)?.kind === "struct")
                    lowered = this.lowerStruct(node.argument, out);
                else
                    lowered = values.map((expr) => this.lowerExpr(expr, out));

                if (plan.strategy === "var")
                    lowered.forEach((value, i) => this.emit(out, this.set(plan.retVars[i], value)));
                let staged = lowered;
                if (plan.strategy === "vstack" && this.pending.length > mark) {
                    staged = lowered.map((value, i): IRExpr => {
                        const name = this.declare(`staged${i}`);
                        this.emit(out, this.set(name, value));
                        return { kind: "var", name };
                    });
                }

                // The script stops here, so slots the enclosing statements pushed would never be popped
                const outer = this.pending.slice(0, mark);
                this.popTo(out, 0);
                this.pending.push(...outer);
                if (plan.strategy === "vstack")
                    for (const value of staged)
                        this.emit(out, {
                            kind: "raw",
                            opcode: "data_addtolist",
                            inputs: [{ kind: "var", name: plan.vStackName! }, value],
                        });
                out.push({ kind: "raw", opcode: "control_stop", inputs: [{ kind: "lit", value: "this script" }] });
                break;
            }
            case "VariableAssignment": {
                if (node.left.type === "TupleExpression") {
                    this.lowerTupleAssignment(node.left.elements, node.right, out);
                    break;
                }
                if (this.lowerStructAssignment(node.left, node.operator, node.right, out)) break;
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
                    const combined: IRExpr =
                        node.operator === "="
                            ? right
                            : this.binop(
                                  node.operator.slice(0, -1),
                                  { kind: "op", opcode: "data_itemoflist", inputs: [structuredClone(vals), slot()] },
                                  right,
                                  out,
                              );
                    const value = (): IRExpr => structuredClone(combined);

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
                if (node.left.type !== "Identifier")
                    throw new KatnipError("IR", "this can't be assigned to; a value from an imported module is read-only", spanOf(node.left));
                if (this.listNames.has(node.left.name)) {
                    if (node.operator !== "=" || node.right.type !== "SliceAccess" || this.listNames.get(node.left.name)!.length > 1)
                        throw new KatnipError("IR", "a whole list or dict can only be replaced with a slice for now", spanOf(node.left));
                    this.assignSlice(this.listNames.get(node.left.name)![0]!, node.right, out);
                    break;
                }
                const value: IRExpr =
                    node.operator === "="
                        ? this.lowerExpr(node.right, out)
                        : this.binop(
                              node.operator.slice(0, -1),
                              this.lowerExpr(node.left, out),
                              this.lowerExpr(node.right, out),
                              out,
                          );
                this.emit(out, this.set(this.local(node.left.name), value));
                break;
            }
            case "VariableDeclaration":
                this.declareMember(node, out);
                break;
            case "ExpressionStatement": {
                const expr = node.expression;
                if (expr.type === "CallExpression") {
                    const sig = this.analyzer.callResolutions.get(expr);
                    if (sig?.meta?.lower === "command" && !this.structListSelf(expr, sig)) {
                        const args = this.callArgs(expr, sig).map((arg) => this.lowerExpr(arg, out));
                        this.emit(out, { kind: "raw", opcode: sig.meta.opcode!, inputs: args });
                        break;
                    }
                }
                // Nothing reads a tuple here, so it's fine that lowerExpr would refuse one
                if (expr.type === "CallExpression" && this.analyzer.exprTypes.get(expr)?.kind === "tuple") {
                    const sig = this.analyzer.callResolutions.get(expr)!;
                    this.lowerUserproc(expr, sig, this.lowerArgs(expr, sig, out), out);
                    break;
                }
                // lowerExpr emits a userproc call itself; any other result is discarded
                this.lowerExpr(node.expression, out);
                break;
            }
        }
        this.popTo(out, mark);
        this.liveRets = liveRets;
        this.stagedRets = stagedRets;
    }

    /** `(a, b) = f();` and `(a, b) = (b, a);`, staged so a value can read a variable written before it. */
    private lowerTupleAssignment(targets: ExpressionNode[], right: ExpressionNode, out: IRStmt[]): void {
        const names = targets.map((target) => {
            if (target.type !== "Identifier" || this.structVars.has(target.name) || this.listNames.has(target.name))
                throw new KatnipError("IR", "a tuple pattern can only assign to plain variables", spanOf(target));
            return this.local(target.name);
        });

        let values: IRExpr[];
        if (right.type === "TupleExpression") {
            values = right.elements.map((element) => this.lowerExpr(element, out));
        } else {
            const sig = right.type === "CallExpression" ? this.analyzer.callResolutions.get(right) : undefined;
            if (!sig || !this.plans.has(sig))
                throw new KatnipError("IR", "a tuple pattern can only unpack a tuple literal or a procedure's return value", spanOf(right));
            const call = right as CallExpressionNode;
            values = this.lowerUserproc(call, sig, this.lowerArgs(call, sig, out), out);
        }
        if (values.length !== names.length)
            throw new KatnipError("IR", "a tuple pattern can't unpack a struct element yet", spanOf(right));
        this.assignStruct(names, values, out);
    }

    /** num => counter, list/str/dict => index. */
    private lowerFor(node: ForStatementNode, out: IRStmt[]): void {
        const type = this.analyzer.exprTypes.get(node.iterable);

        if (type?.kind === "dict") {
            const lists = this.listsOf(node.iterable);
            const parts = node.pattern.type === "TupleExpression" ? node.pattern.elements : [node.pattern];
            const names = parts.map((part) => (part.type === "Identifier" ? part.name : null));
            if (names.length > 2 || names.some((name) => name === null))
                throw new KatnipError("IR", "a dict loop binds one or two plain names", spanOf(node.pattern));

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

        if (type?.kind === "list" && type.element.kind === "struct" && node.pattern.type === "Identifier") {
            const name = node.pattern.name;
            const lists = this.structListOf(node.iterable);
            const iter = this.declare(`${name}_i`);
            const columns = this.structs.get(type.element.name)!.map((field) => this.declare(`${name}_${field.name}`));
            this.structVars.set(name, columns);
            const step = columns.map((column, i) =>
                this.set(column, {
                    kind: "op",
                    opcode: "data_itemoflist",
                    inputs: [{ kind: "var", name: lists[i]! }, { kind: "var", name: iter }],
                }),
            );
            this.emit(out, {
                kind: "for",
                iter,
                times: { kind: "op", opcode: "data_lengthoflist", inputs: [{ kind: "var", name: lists[0]! }] },
                body: [...step, ...this.lowerBlock(node.body)],
            });
            return;
        }
        if (this.lowerForPairs(node, out)) return;
        if (node.pattern.type !== "Identifier")
            throw new KatnipError("IR", "a tuple pattern here isn't supported yet; only dict, zip() and enumerate() loops destructure", spanOf(node.pattern));
        if (this.lowerForRange(node, out)) return;
        const iterable = this.lowerExpr(node.iterable, out);
        const name = this.declare(node.pattern.name);

        if (type?.kind === "primitive" && type.name === "num") {
            this.emit(out, { kind: "for", iter: name, times: iterable, body: this.lowerBlock(node.body) });
            return;
        }
        const isList = type?.kind === "list";
        if (!isList && !(type?.kind === "primitive" && type.name === "str"))
            throw new KatnipError("IR", "a for loop needs a num, str, list or dict; cast this value first", spanOf(node.iterable));

        const index: IRExpr = { kind: "var", name };
        let element: IRExpr;
        if (isList)
            element = { kind: "op", opcode: "data_itemoflist", inputs: [iterable, index] };
        else
            element = { kind: "op", opcode: "operator_letter_of", inputs: [index, iterable] };

        const times: IRExpr = {
            kind: "op",
            opcode: isList ? "data_lengthoflist" : "operator_length",
            inputs: [structuredClone(iterable)],
        };
        this.emit(out, { kind: "for", iter: name, times, body: [this.set(name, element), ...this.lowerBlock(node.body)] });
    }

    /**
     * `for ((a, b), zip(l1, l2))` and `for ((i, v), enumerate(l))` walk by index.
     * The 1-based loop counter is the index, and each pattern part is read out of its own list per iteration.
     * Returns false if the iterable isn't a zip()/enumerate() call.
     */
    private lowerForPairs(node: ForStatementNode, out: IRStmt[]): boolean {
        const call = node.iterable;
        if (call.type !== "CallExpression") return false;
        const sig = this.analyzer.callResolutions.get(call);
        const builtin = sig?.meta?.opcode;
        if (builtin !== "katnip_zip" && builtin !== "katnip_enumerate") return false;

        const parts = node.pattern.type === "TupleExpression" ? node.pattern.elements : [node.pattern];
        const names = parts.map((part) => (part.type === "Identifier" ? part.name : null));
        if (names.length > 2 || names.some((name) => name === null))
            throw new KatnipError("IR", "this loop binds one or two plain names", spanOf(node.pattern));

        const lists = this.callArgs(call, sig!).map((arg) => this.lowerExpr(arg, out));
        const iter = this.declare(names[0]!);
        const item = (list: IRExpr): IRExpr => ({
            kind: "op",
            opcode: "data_itemoflist",
            inputs: [structuredClone(list), { kind: "var", name: iter }],
        });
        // TODO: zip should stop at the shorter list
        const times: IRExpr = { kind: "op", opcode: "data_lengthoflist", inputs: [structuredClone(lists[0]!)] };

        const step: IRStmt[] = [];
        if (builtin === "katnip_enumerate") {
            if (names[1]) step.push(this.set(this.declare(names[1]!), item(lists[0]!)));
        } else {
            if (names[1]) step.push(this.set(this.declare(names[1]!), item(lists[1]!)));
            step.push(this.set(iter, item(lists[0]!))); // last: this write clobbers the index
        }

        this.emit(out, { kind: "for", iter, times, body: [...step, ...this.lowerBlock(node.body)] });
        return true;
    }

    /**
     * `for (x, range(start, stop, step))` becomes: `for (x, floor((stop-start)/step) + 1)`.
     * `range` is 1-based and stop-inclusive, matching Scratch's own repeat counter.
     * Remaps the counter with `x = i * step + (start - step)`.
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
        const start = arg("start") ?? { kind: "lit", value: 1 };
        const stop = arg("stop")!;
        const step = arg("step") ?? { kind: "lit", value: 1 };

        /** Literal value as a number for constant folding, else null. */
        const num = (expr: IRExpr): number | null => {
            if (expr.kind !== "lit") return null;
            const n = Number(expr.value);
            return Number.isFinite(n) ? n : null;
        };
        const [a, b, c] = [num(start), num(stop), num(step)];
        if (c === 0) throw new KatnipError("IR", "range() step cannot be 0", spanOf(call));

        let times: IRExpr;
        if (a !== null && b !== null && c !== null) {
            times = { kind: "lit", value: Math.max(0, Math.floor((b - a) / c) + 1) };
        } else if (a === 1 && c === 1) {
            times = stop; // range(1, n) is already exactly Scratch's `repeat n`
        } else {
            const span: IRExpr = { kind: "op", opcode: "operator_subtract", inputs: [stop, start] };
            const div: IRExpr = c === 1 ? span : { kind: "op", opcode: "operator_divide", inputs: [span, step] };
            times = {
                kind: "op",
                opcode: "operator_add",
                inputs: [
                    { kind: "op", opcode: "operator_mathop", inputs: [{ kind: "lit", value: "floor" }, div] },
                    { kind: "lit", value: 1 },
                ],
            };
        }

        const iter = this.declare((node.pattern as { name: string }).name);
        let value: IRExpr = { kind: "var", name: iter };
        if (c !== 1) value = { kind: "op", opcode: "operator_multiply", inputs: [value, step] };
        let offset: IRExpr;
        if (a !== null && c !== null)
            offset = { kind: "lit", value: a - c };
        else
            offset = { kind: "op", opcode: "operator_subtract", inputs: [start, step] };

        if (num(offset) !== 0) value = { kind: "op", opcode: "operator_add", inputs: [value, offset] };

        this.emit(out, {
            kind: "for",
            iter,
            times,
            body: [...(value.kind === "var" ? [] : [this.set(iter, value)]), ...this.lowerBlock(node.body)],
        });
        return true;
    }

    /** Registers a proc-local, mangled globally. Script-scope temps keep their name (renamed only to clear a global) and are owned by the sprite. */
    private declare(name: string, target: IRSprite | IRProgram = this.sprite ?? this.program): string {
        if (!this.currentPlan) {
            if (target === this.sprite) name = this.spriteName(name);
            const scope = target.variables;
            if (!scope.has(name)) scope.set(name, 0);
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
    private emittedName(node: VariableDeclarationNode): string {
        const { name } = node;
        if (isPublicVar(node)) return name;
        return this.spriteName(name);
    }

    private spriteName(name: string): string {
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

    /**
     * Appends an if whose condition setup was lowered into `out` since `mark`. Only one branch runs,
     * so each pops that setup's slots itself instead of leaving them for the statement after.
     */
    private branch(out: IRStmt[], mark: number, cond: IRExpr, then: BlockNode, otherwise: IRStmt[]): void {
        this.freeze(cond);
        const pops: IRStmt[] = [];
        this.popTo(pops, mark);
        out.push({
            kind: "if",
            cond,
            then: [...pops, ...this.lowerBlock(then)],
            else: [...structuredClone(pops), ...otherwise],
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

    private binop(op: string, left: IRExpr, right: IRExpr, out: IRStmt[]): IRExpr {
        const opcode = binaryOpcodes[op];
        if (opcode) return { kind: "op", opcode, inputs: [left, right] };

        const power = op === "**" ? this.inlinePower(left, right, out) : null;
        if (power) return power;

        const composed = this.operatorProcs.get(op);
        if (composed?.meta?.lower === "builds") return this.inlineBuilds(composed, [left, right], out);
        if (composed) return this.callPlan(composed, [left, right], out)[0]!;
        throw new KatnipError("IR", `the '${op}' operator isn't supported yet`);
    }

    /** `**` with a literal exponent, when plain blocks read better than a call to math.pow; else null. */
    private inlinePower(left: IRExpr, right: IRExpr, out: IRStmt[]): IRExpr | null {
        const exponent = literalValue(right);
        if (exponent === null) return null;
        const base = literalValue(left);
        if (base !== null && Number.isFinite(base ** exponent)) return { kind: "lit", value: base ** exponent };
        if (exponent === 0) return { kind: "lit", value: 1 };
        if (exponent === 1) return left;
        if (exponent === 0.5) return { kind: "op", opcode: "operator_mathop", inputs: [{ kind: "lit", value: "sqrt" }, left] };
        if (!Number.isInteger(exponent) || exponent < 0 || exponent > MAX_INLINE_POWER) return null;

        const factor = this.reusable(left, out);
        let product = structuredClone(factor);
        for (let i = 1; i < exponent; i++)
            product = { kind: "op", opcode: "operator_multiply", inputs: [product, structuredClone(factor)] };
        return product;
    }

    /**
     * An expression that can be written out more than once. Copies of anything bigger than a plain
     * read would add blocks, and would disagree for a reporter like `math.random`, so those go in a temp.
     */
    private reusable(expr: IRExpr, out: IRStmt[]): IRExpr {
        if (expr.kind === "lit" || expr.kind === "param") return expr;
        // A later call in the statement moves a return variable by editing this one node, which a copy would miss
        if (expr.kind === "var" && !this.liveRets.includes(expr)) return expr;
        const name = this.declare(`ret_stage${this.stagedRets++}`);
        this.emit(out, this.set(name, expr));
        // Read by that set, so a later call must not move it
        const read = nodesIn(expr);
        this.liveRets = this.liveRets.filter((ret) => !read.has(ret));
        return { kind: "var", name };
    }

    /** Evaluates `s[a:b:c]` on a str through its stdlib proc, or on a list into a hidden one. */
    private lowerSlice(node: SliceAccessNode, out: IRStmt[]): IRExpr {
        const type = this.analyzer.exprTypes.get(node.object);
        if (type?.kind === "list") {
            const hidden = this.mangle(`slice${this.sliceLists++}`);
            (this.sprite ?? this.program).lists.set(hidden, []);
            this.fillSlice(hidden, node, out);
            return { kind: "var", name: hidden };
        }
        if (type?.kind !== "primitive" || type.name !== "str")
            throw new KatnipError("IR", "only a str or a list can be sliced; cast this value first", spanOf(node.object));

        const object = this.lowerExpr(node.object, out);
        const indices = inlineSliceIndices(node);
        if (indices) {
            if (indices.length === 0) return { kind: "lit", value: "" };
            const text = indices.length > 1 ? this.reusable(object, out) : object;
            return indices
                .map((value): IRExpr => ({
                    kind: "op",
                    opcode: "operator_letter_of",
                    inputs: [{ kind: "lit", value }, structuredClone(text)],
                }))
                .reduceRight((right, left) => ({ kind: "op", opcode: "operator_join", inputs: [left, right] }));
        }

        const length: IRExpr = { kind: "op", opcode: "operator_length", inputs: [structuredClone(object)] };
        const bounds = this.sliceBounds(node, length, out);
        return this.callPlan(this.operatorProcs.get("[:]")!, [object, ...bounds], out)[0]!;
    }

    /** start, stop, step. An omitted bound depends on the step's sign, so that must be known here. */
    private sliceBounds(node: SliceAccessNode, length: IRExpr, out: IRStmt[]): [IRExpr, IRExpr, IRExpr] {
        const step = node.step ? literalNumber(node.step) : 1;
        if (step === 0) throw new KatnipError("IR", "a slice step cannot be 0", spanOf(node.step!));
        if (step === null && (!node.start || !node.end))
            throw new KatnipError("IR", "a slice with a computed step needs both its start and its stop", spanOf(node));
        const backwards = step !== null && step < 0;
        const one: IRExpr = { kind: "lit", value: 1 };
        const start = node.start ? this.lowerExpr(node.start, out) : backwards ? length : one;
        const stop = node.end ? this.lowerExpr(node.end, out) : backwards ? structuredClone(one) : structuredClone(length);
        return [start, stop, node.step ? this.lowerExpr(node.step, out) : structuredClone(one)];
    }

    /** `dst = src[a:b:c]`; slicing a list onto itself goes through a hidden copy, as filling clears the target first. */
    private assignSlice(dst: string, node: SliceAccessNode, out: IRStmt[]): void {
        if (node.object.type === "Identifier" && this.listNames.get(node.object.name)?.[0] === dst) {
            const hidden = this.lowerSlice(node, out) as { name: string };
            const length: IRExpr = { kind: "op", opcode: "data_lengthoflist", inputs: [{ kind: "var", name: hidden.name }] };
            this.callSliceProc(hidden.name, dst, [{ kind: "lit", value: 1 }, length, { kind: "lit", value: 1 }], out);
            return;
        }
        this.fillSlice(dst, node, out);
    }

    private fillSlice(dst: string, node: SliceAccessNode, out: IRStmt[]): void {
        const lists = this.listsOf(node.object);
        if (lists.length !== 1) throw new KatnipError("IR", "a dict can't be sliced", spanOf(node.object));
        const length: IRExpr = { kind: "op", opcode: "data_lengthoflist", inputs: [{ kind: "var", name: lists[0]! }] };
        this.callSliceProc(lists[0]!, dst, this.sliceBounds(node, length, out), out);
    }

    private callSliceProc(src: string, dst: string, bounds: IRExpr[], out: IRStmt[]): void {
        const owner = this.sprite ?? this.program;
        const proc = `slice_${src}_to_${dst}`;
        const key = `${this.sprite?.name ?? ""}/${proc}`;
        if (!this.sliceProcs.has(key)) {
            this.sliceProcs.add(key);
            owner.procs.set(proc, sliceProc(proc, src, dst, this.mangle(`${proc}_i`), owner));
        }
        this.emit(out, { kind: "call", proc, args: bounds });
    }

    /** Emits a userproc call and returns its return variables, keeping earlier ones this statement still reads safe. */
    private callPlan(sig: Signature, args: IRExpr[], out: IRStmt[]): IRExpr[] {
        const plan = this.plans.get(sig)!;
        if (sig.meta?.stdlib) this.usedStdlib.add(sig);

        // An argument is read as the call starts, so only what's left over needs moving clear of the call.
        const consumed = nodesIn(args);
        for (const ret of this.liveRets) {
            if (consumed.has(ret)) continue;
            const name = this.declare(`ret_stage${this.stagedRets++}`);
            this.emit(out, this.set(name, { kind: "var", name: ret.name }));
            ret.name = name;
        }
        this.liveRets = [];

        this.emit(out, { kind: "call", proc: plan.mangled, args });
        if (!plan.strategy) return [];
        if (plan.strategy === "var") {
            const rets = plan.retVars.map((name): Extract<IRExpr, { kind: "var" }> => ({ kind: "var", name }));
            this.liveRets.push(...rets);
            return rets;
        }
        const width = plan.returns.kind === "tuple" ? plan.returns.width : 1;
        return this.pushVstack(plan.vStackName!, width);
    }

    /** Lowers an expression, pushing any setup statements into `out`. The returned IRExpr is always call-free. */
    private lowerExpr(node: ExpressionNode, out: IRStmt[]): IRExpr {
        switch (node.type) {
            case "Literal":
                return { kind: "lit", value: node.value ?? "" };

            case "Identifier": {
                const operand = this.substitutions?.get(node.name);
                if (operand) return operand;
                if (this.params.has(node.name)) return { kind: "param", name: node.name };
                if (this.structVars.has(node.name) || this.structLists.has(node.name))
                    throw new KatnipError("IR", `struct '${node.name}' can only be used through its fields here`, spanOf(node));
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
                if (this.analyzer.exprTypes.get(node.left)?.kind === "list")
                    throw new KatnipError("IR", `'${node.operator}' on whole lists isn't supported yet`, spanOf(node));

                return this.binop(node.operator, left, right, out);
            }
            case "CallExpression": {
                const sig = this.analyzer.callResolutions.get(node);
                // A struct literal has no signature; lowerStruct reads it wherever a struct is expected
                if (!sig)
                    throw new KatnipError("IR", "a struct literal can only be used where a struct is expected", spanOf(node));
                const columns = this.structListSelf(node, sig);
                if (columns) return this.lowerStructListCall(node, sig, columns, out);
                const args = this.lowerArgs(node, sig, out);

                if (sig.meta?.lower === "reporter") return { kind: "op", opcode: sig.meta.opcode!, inputs: args };
                if (sig.meta?.lower === "builds") return this.inlineBuilds(sig, args, out);

                if (this.analyzer.exprTypes.get(node)?.kind === "tuple")
                    throw new KatnipError("IR", "a tuple return must be unpacked with a pattern: (a, b) = f();", spanOf(node));
                return this.lowerUserproc(node, sig, args, out)[0] ?? { kind: "lit", value: "" };
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
                const owner =
                    node.object.type === "Identifier" ? node.object.name
                    : node.object.type === "MemberExpression" ? node.object.property.name
                    : null;
                if (owner !== null) {
                    const value = this.analyzer.constMembers.get(`${owner}.${node.property.name}`);
                    if (value !== undefined) return { kind: "lit", value };
                }
                const type = this.analyzer.exprTypes.get(node.object);
                if (type?.kind === "struct")
                    return this.lowerStruct(node.object, out)[this.fieldIndex(type.name, node.property.name)]!;
                if (type?.kind === "list" && type.element.kind === "struct")
                    return { kind: "var", name: this.listsOf(node)[0]! };
                break;
            }
            case "SliceAccess":
                return this.lowerSlice(node, out);
            case "TupleExpression":
                throw new KatnipError("IR", "a tuple can only be returned or unpacked for now", spanOf(node));
        }
        throw new KatnipError("IR", "this kind of value can't be used here yet", spanOf(node));
    }

    /** Call arguments in signature order; a struct argument spreads into one value per field. */
    private lowerArgs(node: CallExpressionNode, sig: Signature, out: IRStmt[]): IRExpr[] {
        return this.callArgs(node, sig).flatMap((arg, i) => {
            if (this.structFieldsOf(sig.params[i]!.paramType)) return this.lowerStruct(arg, out);
            return [this.lowerExpr(arg, out)];
        });
    }

    /** Emits a userproc call and returns its return slots, one per returned value. */
    private lowerUserproc(node: CallExpressionNode, sig: Signature, args: IRExpr[], out: IRStmt[]): IRExpr[] {
        const plan = this.plans.get(sig);
        if (!plan)
            throw new KatnipError("IR", `@lower = "${sig.meta?.lower}" procs are not lowered yet`, spanOf(node));
        return this.callPlan(sig, args, out);
    }

    /**
     * Struct writes: `p = q`, `p.x = v`, `ps[i] = q` and `ps[i].x = v`, each onto the backing columns.
     * Returns false when the target isn't struct-shaped.
     */
    private lowerStructAssignment(left: ExpressionNode, operator: string, right: ExpressionNode, out: IRStmt[]): boolean {
        if (left.type === "Identifier" && this.structVars.has(left.name)) {
            this.assignStruct(this.structVars.get(left.name)!, this.lowerStruct(right, out), out);
            return true;
        }
        if (left.type === "IndexerAccess" && left.object.type === "Identifier" && this.structLists.has(left.object.name)) {
            const index = this.lowerExpr(left.index, out);
            const values = this.lowerStruct(right, out);
            this.structLists.get(left.object.name)!.forEach((name, i) =>
                this.emit(out, {
                    kind: "raw",
                    opcode: "data_replaceitemoflist",
                    inputs: [{ kind: "var", name }, structuredClone(index), values[i]!],
                }),
            );
            return true;
        }
        if (left.type !== "MemberExpression") return false;
        const type = this.analyzer.exprTypes.get(left.object);
        if (type?.kind !== "struct") return false;

        const field = this.fieldIndex(type.name, left.property.name);
        const value = (current: IRExpr): IRExpr => {
            if (operator === "=") return this.lowerExpr(right, out);
            return this.binop(operator.slice(0, -1), current, this.lowerExpr(right, out), out);
        };
        const owner = left.object;
        if (owner.type === "Identifier") {
            const column = this.structVars.get(owner.name)![field]!;
            this.emit(out, this.set(column, value(this.column(column))));
            return true;
        }
        if (owner.type === "IndexerAccess") {
            const list: IRExpr = { kind: "var", name: this.structListOf(owner.object)[field]! };
            const index = this.lowerExpr(owner.index, out);
            const current: IRExpr = {
                kind: "op",
                opcode: "data_itemoflist",
                inputs: [structuredClone(list), structuredClone(index)],
            };
            this.emit(out, {
                kind: "raw",
                opcode: "data_replaceitemoflist",
                inputs: [list, structuredClone(index), value(current)],
            });
            return true;
        }
        throw new KatnipError("IR", "this struct field can't be assigned to yet", spanOf(left));
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
function literals(nodes: (ExpressionNode | undefined)[]): (string | number | boolean)[] | null {
    const values: (string | number | boolean)[] = [];
    for (const node of nodes) {
        if (!node) {
            values.push("");
            continue;
        }
        if (node.type !== "Literal") return null;
        values.push(node.value ?? "");
    }
    return values;
}

/** The value of a literal or a negated literal, else null. */
function literalNumber(node: ExpressionNode): number | null {
    if (node.type === "Literal" && typeof node.value === "number") return node.value;
    if (node.type === "UnaryExpression" && node.operator === "-") {
        const value = literalNumber(node.argument);
        if (value !== null) return -value;
    }
    return null;
}

/** Every object in an IR tree, by identity. */
function nodesIn(root: unknown, found = new Set<unknown>()): Set<unknown> {
    if (root === null || typeof root !== "object") return found;
    found.add(root);
    for (const value of Object.values(root)) nodesIn(value, found);
    return found;
}

/** literalNumber for lowered IR, where `-2` has become `0 - 2`. */
function literalValue(expr: IRExpr): number | null {
    if (expr.kind === "lit") return typeof expr.value === "number" ? expr.value : null;
    if (expr.kind !== "op" || expr.opcode !== "operator_subtract") return null;
    const [left, right] = expr.inputs.map(literalValue);
    return left == null || right == null ? null : left - right;
}

/** The letters a slice reads, when its bounds are known here and few enough to write out; else null. */
function inlineSliceIndices(node: SliceAccessNode): number[] | null {
    const step = node.step ? literalNumber(node.step) : 1;
    if (step === null || step === 0) return null;
    // Open ends that reach the string's end depend on its length, which only exists at runtime
    let start = step > 0 ? 1 : null;
    if (node.start) start = literalNumber(node.start);
    let stop = step < 0 ? 1 : null;
    if (node.end) stop = literalNumber(node.end);
    if (start === null || stop === null || ![start, stop, step].every(Number.isInteger)) return null;

    const count = Math.max(0, Math.floor((stop - start) / step) + 1);
    if (count > MAX_INLINE_SLICE) return null;
    return Array.from({ length: count }, (_, i) => start + i * step);
}

/** A warp proc copying src[start:stop:step] into dst. A plain loop in a script would yield once per element. */
function sliceProc(name: string, src: string, dst: string, iter: string, owner: IRSprite | IRProgram): IRProc {
    owner.variables.set(iter, 0);
    const param = (name: string): IRExpr => ({ kind: "param", name });
    const op = (opcode: string, ...inputs: IRExpr[]): IRExpr => ({ kind: "op", opcode, inputs });
    const i: IRExpr = { kind: "var", name: iter };
    const list = (name: string): IRExpr => ({ kind: "var", name });
    const span = op("operator_divide", op("operator_subtract", param("stop"), param("start")), param("step"));
    const inRange = op(
        "operator_and",
        op("operator_gt", i, { kind: "lit", value: 0 }),
        op("operator_not", op("operator_gt", i, op("data_lengthoflist", list(src)))),
    );
    return {
        name,
        params: ["start", "stop", "step"].map((name) => ({ name, type: paramType.NUMBER })),
        returns: { kind: "void" },
        warp: true,
        strategy: null,
        vStackName: null,
        retVars: [],
        temps: [],
        body: [
            { kind: "raw", opcode: "data_deletealloflist", inputs: [list(dst)] },
            { kind: "raw", opcode: "data_setvariableto", inputs: [i, param("start")] },
            {
                kind: "if",
                cond: op("operator_not", op("operator_equals", param("step"), { kind: "lit", value: 0 })),
                then: [
                    {
                        kind: "repeat",
                        times: op("operator_add", op("operator_mathop", { kind: "lit", value: "floor" }, span), { kind: "lit", value: 1 }),
                        body: [
                            {
                                kind: "if",
                                cond: inRange,
                                then: [{ kind: "raw", opcode: "data_addtolist", inputs: [list(dst), op("data_itemoflist", list(src), i)] }],
                                else: [],
                            },
                            { kind: "raw", opcode: "data_setvariableto", inputs: [i, op("operator_add", i, param("step"))] },
                        ],
                    },
                ],
                else: [],
            },
        ],
    };
}

/** Whether an IR tree reads any of `names` as a variable. */
function mentions(node: unknown, names: Set<string>): boolean {
    if (node === null || typeof node !== "object") return false;
    const expr = node as { kind?: string; name?: string };
    if (expr.kind === "var" && names.has(expr.name!)) return true;
    return Object.values(node).some((value) => mentions(value, names));
}

function spanOf(node: { loc: SourceLocation }) {
    return {
        line: node.loc.start.line,
        column: node.loc.start.column,
        endLine: node.loc.end.line,
        endColumn: node.loc.end.column,
    };
}

/** Scratch inputs are only %n, %s, %b; num -> NUMBER, bool -> BOOLEAN, everything else -> STRING. */
function paramTypeOf(type: TypeNode): paramType {
    if (type.type !== "Type") return paramType.STRING;
    if (type.typeName === "num") return paramType.NUMBER;
    if (type.typeName === "bool") return paramType.BOOLEAN;
    return paramType.STRING;
}

/** Past these, `x * x * x * x` and long join chains read worse in the editor than a call. */
const MAX_INLINE_POWER = 3;
const MAX_INLINE_SLICE = 8;

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
    // !=, <=, >=, !&, !|, !^ and ^ have no opcode: they come from the @lower = "builds" procs
}