import {
    isBlock,
    type Block,
    type BlockMap,
    type InputSlot,
    type ProcedureCallMutation,
    type ProcedurePrototypeMutation,
    type Sb3Project,
    type Scalar,
    type Target,
} from "../codegen/SB3TypeDefs.js";
import { opcodeSlots, type Slot } from "../codegen/scratchDefs.js";
import { bindingPowerTable } from "../parser/BindingPowerTable.js";
import { stdlibTable, takesText, tyOf, type StdlibBlock, type StdlibParam, type Ty } from "./stdlib.js";

interface Expr {
    code: string;
    ty: Ty;
    prec: number;
    lit?: Scalar;
    not?: Expr;
}

interface ProcInfo {
    name: string;
    params: { raw: string; ident: string; ty: Ty }[];
}

const ATOM = 100;
const UNARY = bindingPowerTable["!"]!.rbp;
const INDENT = "    ";

const keywords = [
    "if", "elif", "else", "while", "do", "for", "forever", "repeat", "switch", "case", "default", "return",
    "proc", "sprite", "stage", "enum", "struct", "public", "private", "import", "costume", "sound", "as",
    "self", "true", "false", "any", "num", "str", "bool", "list", "dict", "void",
];

const arithmetic: Record<string, string> = {
    operator_add: "+",
    operator_subtract: "-",
    operator_multiply: "*",
    operator_divide: "/",
    operator_mod: "%",
};

const mathHelpers: Record<string, string> = {
    abs: "abs", floor: "floor", ceiling: "ceil", sqrt: "sqrt",
    sin: "sin", cos: "cos", tan: "tan", asin: "asin", acos: "acos", atan: "atan",
    ln: "ln", log: "log", "e ^": "epow",
};

const casts: Record<Exclude<Ty, "any">, string> = { num: "Num", str: "Str", bool: "Bool" };

const escapes: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function escape(text: string): string {
    return text.replace(/[\\"\x00-\x1f]/g, (c) => escapes[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const quote = (text: string) => `"${escape(text)}"`;

function canonicalNumber(value: Scalar): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || value.trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && String(n) === value ? n : null;
}

function looseNumber(value: Scalar): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value)) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

const isStopScript = (block: Block) => block.opcode === "control_stop" && block.fields.STOP_OPTION?.[0] === "this script";

const atom = (code: string, ty: Ty, lit?: Scalar): Expr => ({ code, ty, prec: ATOM, lit });

function numLit(n: number): Expr {
    return { code: String(n), ty: "num", prec: n < 0 ? UNARY : ATOM, lit: n };
}

const strLit = (text: string): Expr => atom(quote(text), "str", text);

function scalarLit(value: Scalar): Expr {
    if (typeof value === "boolean") return atom(String(value), "bool", value);
    const n = canonicalNumber(value);
    if (n !== null) return numLit(n);
    return strLit(String(value));
}

const wrap = (e: Expr, min: number) => (e.prec < min ? `(${e.code})` : e.code);

function identifier(name: string): string {
    const cleaned = name.trim().replace(/[^A-Za-z0-9_]+/g, "_");
    return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Hands out identifiers unique across this scope and every scope it was made from. */
class Names {
    private used: Set<string>;
    constructor(used: Iterable<string>) {
        this.used = new Set(used);
    }

    child(): Names {
        return new Names(this.used);
    }

    claim(raw: string): string {
        const base = identifier(raw);
        let name = base;
        for (let n = 2; this.used.has(name); n++) name = `${base}${n}`;
        this.used.add(name);
        return name;
    }
}

export class Decompiler {
    private stdlib = stdlibTable();
    private globals = new Names([...keywords, ...this.stdlib.names]);
    private globalVars = new Map<string, string>();
    private globalLists = new Map<string, string>();

    private scope = this.globals;
    private vars = new Map<string, string>();
    private lists = new Map<string, string>();
    private blocks: BlockMap = {};
    private procs = new Map<string, ProcInfo>();
    private params = new Map<string, { ident: string; ty: Ty }>();
    private inProc = false;
    private notes: string[] = [];

    decompile(project: Sb3Project): string {
        const stage = project.targets.find((t) => t.isStage);
        const sprites = project.targets.filter((t) => !t.isStage);
        const out: string[] = [];

        if (stage) {
            out.push(...this.declare(stage, "public", this.globalVars, this.globalLists));
            const body = this.target(stage);
            if (body.length) out.push("", "stage {", ...body, "}");
        }

        for (const sprite of sprites) {
            this.scope = this.globals.child();
            this.vars = new Map(this.globalVars);
            this.lists = new Map(this.globalLists);
            const declarations = this.declare(sprite, "private", this.vars, this.lists).map((line) => INDENT + line);
            const body = this.target(sprite);
            if (declarations.length && body.length) declarations.push("");

            out.push("", `sprite ${this.globals.claim(sprite.name)} {`, ...declarations, ...body, "}");
        }
        return out.join("\n").replace(/^\n+/, "") + "\n";
    }

    private declare(target: Target, access: string, vars: Map<string, string>, lists: Map<string, string>): string[] {
        const lines: string[] = [];
        for (const [id, [name, value]] of Object.entries(target.variables)) {
            const ident = this.scope.claim(name);
            vars.set(id, ident);
            lines.push(`${access} ${ident}: any = ${scalarLit(value).code};`);
        }
        for (const [id, [name, values]] of Object.entries(target.lists)) {
            const ident = this.scope.claim(name);
            lists.set(id, ident);
            lines.push(`${access} ${ident}: list<any> = [${values.map((v) => scalarLit(v).code).join(", ")}];`);
        }
        return lines;
    }

    private target(target: Target): string[] {
        this.blocks = target.blocks;
        const tops = Object.values(target.blocks)
            .filter((b): b is Block => isBlock(b) && b.topLevel)
            .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));

        const definitions = tops.filter((b) => b.opcode === "procedures_definition");
        this.procs = new Map();
        for (const def of definitions) this.registerProc(def);

        const sections = definitions.map((def) => this.proc(def));
        for (const top of tops) {
            const hat = this.stdlib.byOpcode.get(top.opcode);
            if (hat?.hat) sections.push(this.hat(top, hat));
            else if (/_when/.test(top.opcode)) sections.push([`${INDENT}# unsupported: ${top.opcode} script`]);
        }
        return sections.flatMap((section, i) => (i ? ["", ...section] : section));
    }

    private prototype(def: Block): ProcedurePrototypeMutation {
        return (this.blocks[def.inputs.custom_block![1] as string] as Block).mutation as ProcedurePrototypeMutation;
    }

    private registerProc(def: Block): void {
        const mutation = this.prototype(def);
        const names: string[] = JSON.parse(mutation.argumentnames);
        const specs = mutation.proccode.match(/%[snb]/g) ?? [];
        const words = mutation.proccode.split(/\s+/).filter((w) => !/^%[snb]$/.test(w));

        // The compiler's own `name a %s b %n` shape gives back the name it was written with
        const tokens = mutation.proccode.split(" ");
        const generated = tokens.length === 1 + 2 * names.length
            && names.every((name, i) => tokens[1 + 2 * i] === name && /^%[snb]$/.test(tokens[2 + 2 * i]!));
        let name = words.join("_");
        if (generated) name = tokens[0]!;
        if (!/[A-Za-z0-9]/.test(name)) name = "block";

        const params = this.scope.child();
        this.procs.set(mutation.proccode, {
            name: this.scope.claim(name),
            params: names.map((raw, i) => ({ raw, ident: params.claim(raw), ty: specs[i] === "%b" ? "bool" : "any" })),
        });
    }

    private proc(def: Block): string[] {
        const mutation = this.prototype(def);
        const info = this.procs.get(mutation.proccode)!;
        this.params = new Map(info.params.map((p) => [p.raw, { ident: p.ident, ty: p.ty }]));

        const header: string[] = [];
        if (mutation.warp === "true") header.push("@warp = true");
        const spec = (ty: Ty) => (ty === "bool" ? "%b" : "%s");
        const generated = [info.name, ...info.params.map((p) => `${p.ident} ${spec(p.ty)}`)].join(" ");
        if (mutation.proccode.replace(/%n/g, "%s") !== generated) {
            let i = 0;
            const proccode = mutation.proccode.replace(/%[snb]/g, () => `%${info.params[i++]?.ident ?? "_"}`);
            header.push(`@proccode = ${quote(proccode)}`);
        }
        header.push(...info.params.map((p) => `${p.ident}: ${p.ty}`));

        this.inProc = true;
        const lines = this.body(`${INDENT}proc ${info.name}(${header.join(", ")}) -> void`, def.next, INDENT, true);
        this.inProc = false;
        this.params = new Map();
        return lines;
    }

    private hat(top: Block, entry: StdlibBlock): string[] {
        this.notes = [];
        const call = this.call(top, entry);
        return [...this.flushNotes(INDENT), ...this.body(`${INDENT}${call.code}`, top.next, INDENT, true)];
    }

    /** `header {` stack `}`, or `header {}` when the stack is empty. */
    private body(header: string, first: string | null | undefined, indent: string, tail = false): string[] {
        const inner = this.stack(first ?? null, indent + INDENT, tail);
        if (!inner.length) return [`${header} {}`];
        return [`${header} {`, ...inner, `${indent}}`];
    }

    private substack(block: Block, name: string): string | null {
        const value = block.inputs[name]?.[1];
        return typeof value === "string" ? value : null;
    }

    /** `tail`: the script ends when this stack does, so a "stop this script" at its end does nothing. */
    private stack(id: string | null, indent: string, tail = false): string[] {
        const lines: string[] = [];
        for (; id; id = (this.blocks[id] as Block).next) {
            const block = this.blocks[id] as Block;
            const last = tail && !block.next;
            if (!(last && isStopScript(block))) lines.push(...this.stmt(block, indent, last));
        }
        return lines;
    }

    private flushNotes(indent: string): string[] {
        const notes = [...new Set(this.notes)].map((note) => `${indent}# unsupported: ${note}`);
        this.notes = [];
        return notes;
    }

    private stmt(block: Block, indent: string, tail: boolean): string[] {
        const outer = this.notes;
        this.notes = [];
        const lines = this.stmtLines(block, indent, tail);
        const notes = this.flushNotes(indent);
        this.notes = outer;
        return [...notes, ...lines];
    }

    private stmtLines(block: Block, indent: string, tail: boolean): string[] {
        const line = (code: string) => [`${indent}${code}`];
        const sub = this.substack(block, "SUBSTACK");
        switch (block.opcode) {
            case "control_if":
            case "control_if_else":
                return this.ifChain(block, indent, tail);
            case "control_while":
                return this.body(`${indent}while (${this.input(block, "CONDITION", "bool").code})`, sub, indent);
            case "control_repeat_until":
                return this.body(`${indent}while (${this.negate(this.input(block, "CONDITION", "bool")).code})`, sub, indent);
            case "control_wait_until":
                return line(`while (${this.negate(this.input(block, "CONDITION", "bool")).code}) {}`);
            case "control_forever":
                return this.body(`${indent}forever`, sub, indent);
            case "control_repeat":
                return this.body(`${indent}repeat (${this.count(block, "TIMES").code})`, sub, indent);
            case "control_for_each": {
                const variable = this.varField(block, "VARIABLE");
                const header = (counter: string) => `${indent}for (${counter}, ${this.count(block, "VALUE").code})`;
                // A loop variable shadows globals and is proc-local in procs, so only a sprite variable in a script can count itself
                const [, id] = block.fields.VARIABLE ?? [];
                if (!this.inProc && !this.globalVars.has(id ?? "")) return this.body(header(variable), sub, indent);
                const counter = this.scope.claim("i");
                return [
                    `${header(counter)} {`,
                    `${indent}${INDENT}${variable} = ${counter};`,
                    ...this.stack(sub, indent + INDENT),
                    `${indent}}`,
                ];
            }
            case "data_setvariableto":
                return line(`${this.varField(block, "VARIABLE")} = ${this.input(block, "VALUE", "any").code};`);
            case "data_changevariableby":
                return line(`${this.varField(block, "VARIABLE")} += ${this.input(block, "VALUE", "num").code};`);
            case "data_replaceitemoflist":
                return line(`${this.listField(block)}[${this.listIndex(block).code}] = ${this.input(block, "ITEM", "any").code};`);
            case "data_deleteoflist": {
                if (this.input(block, "INDEX", "any").lit === "all") return line(`${this.listField(block)}.clear();`);
                return line(`${this.listField(block)}.remove(${this.cast(this.listIndex(block), "num").code});`);
            }
            case "procedures_call":
                return line(`${this.procCall(block).code};`);
        }
        const entry = this.stdlib.byOpcode.get(block.opcode);
        if (!entry || entry.hat) return line(`# unsupported: ${block.opcode}`);
        return line(`${this.call(block, entry).code};`);
    }

    private ifChain(block: Block, indent: string, tail: boolean): string[] {
        const lines: string[] = [];
        const inner = indent + INDENT;
        let current = block;
        let head = `${indent}if`;
        for (;;) {
            lines.push(`${head} (${this.input(current, "CONDITION", "bool").code}) {`);
            lines.push(...this.stack(this.substack(current, "SUBSTACK"), inner, tail));

            const elseFirst = current.opcode === "control_if_else" ? this.substack(current, "SUBSTACK2") : null;
            if (!elseFirst) break;
            const next = this.blocks[elseFirst] as Block;
            if ((next.opcode === "control_if" || next.opcode === "control_if_else") && !next.next) {
                current = next;
                head = `${indent}} elif`;
                continue;
            }
            lines.push(`${indent}} else {`, ...this.stack(elseFirst, inner, tail));
            break;
        }
        lines.push(`${indent}}`);
        return lines;
    }


    private varField(block: Block, name: string): string {
        const [raw, id] = block.fields[name] ?? [""];
        return this.vars.get(id ?? "") ?? identifier(raw ?? "");
    }

    private listField(block: Block): string {
        const [raw, id] = block.fields.LIST ?? [""];
        return this.lists.get(id ?? "") ?? identifier(raw ?? "");
    }

    private listIndex(block: Block): Expr {
        const index = this.input(block, "INDEX", "any");
        const length = `${this.listField(block)}.length()`;
        if (index.lit === "last") return atom(length, "num");
        if (index.lit === "random" || index.lit === "any") return atom(`math.random(1, ${length})`, "num");
        return index;
    }

    /** A `for` over anything but a known num is a list or string walk, not a counter. */
    private count(block: Block, name: string): Expr {
        return this.cast(this.input(block, name, "num"), "num", true);
    }

    private input(block: Block, name: string, want: Ty): Expr {
        return this.cast(this.value(block.inputs[name]?.[1] ?? null, want), want);
    }

    private value(slot: InputSlot | null, want: Ty): Expr {
        if (slot === null) {
            if (want === "bool") return atom("false", "bool", false);
            if (want === "num") return numLit(0);
            return strLit("");
        }
        if (typeof slot === "string") return this.expr(this.blocks[slot] as Block);
        switch (slot[0]) {
            case 10: {
                const n = want === "str" ? null : canonicalNumber(slot[1]);
                return n === null ? strLit(String(slot[1])) : numLit(n);
            }
            case 9:
                return strLit(String(slot[1]));
            case 11:
                return strLit(slot[1]);
            case 12:
                return atom(this.vars.get(slot[2]) ?? identifier(slot[1]), "any");
            case 13:
                this.notes.push("list used as a value");
                return atom(this.lists.get(slot[2]) ?? identifier(slot[1]), "any");
            default: {
                if (String(slot[1]) === "") return numLit(0);
                const n = looseNumber(slot[1]);
                return n === null ? strLit(String(slot[1])) : numLit(n);
            }
        }
    }

    /** `strict` also casts an `any`, for the spots the checker needs to know the type statically. */
    private cast(e: Expr, want: Ty, strict = false): Expr {
        if (want === "any" || e.ty === want || (e.ty === "any" && !strict)) return e;
        if (e.lit !== undefined) {
            if (want === "str") return strLit(String(e.lit));
            const n = looseNumber(e.lit);
            if (want === "num" && n !== null) return numLit(n);
        }
        return atom(`${casts[want]}(${e.code})`, want);
    }

    private binary(op: string, left: Expr, right: Expr, ty: Ty): Expr {
        const power = bindingPowerTable[op]!.lbp;
        return { code: `${wrap(left, power)} ${op} ${wrap(right, power + 1)}`, ty, prec: power };
    }

    private negate(e: Expr): Expr {
        if (e.not) return e.not;
        if (typeof e.lit === "boolean") return atom(String(!e.lit), "bool", !e.lit);
        const operand = e.ty === "any" ? this.cast({ ...e, ty: "num" }, "bool") : e;
        return { code: `!${wrap(operand, UNARY)}`, ty: "bool", prec: UNARY, not: e };
    }

    private expr(block: Block): Expr {
        const { opcode } = block;
        const op = arithmetic[opcode];
        if (op) return this.binary(op, this.input(block, "NUM1", "num"), this.input(block, "NUM2", "num"), "num");

        switch (opcode) {
            case "operator_lt":
            case "operator_gt":
            case "operator_equals": {
                const left = this.input(block, "OPERAND1", "any");
                const right = this.input(block, "OPERAND2", "any");
                // How the compiler spells the bool literals: "true" == "true" and "false" == ""
                if (opcode === "operator_equals" && left.lit === "true" && right.lit === "true") return atom("true", "bool", true);
                if (opcode === "operator_equals" && left.lit === "false" && right.lit === "") return atom("false", "bool", false);
                const symbol = { operator_lt: "<", operator_gt: ">", operator_equals: "==" }[opcode];
                const inverse = { operator_lt: ">=", operator_gt: "<=", operator_equals: "!=" }[opcode];
                return { ...this.binary(symbol, left, right, "bool"), not: this.binary(inverse, left, right, "bool") };
            }
            case "operator_and":
            case "operator_or": {
                const symbol = opcode === "operator_and" ? "&&" : "||";
                return this.binary(symbol, this.input(block, "OPERAND1", "bool"), this.input(block, "OPERAND2", "bool"), "bool");
            }
            case "operator_not":
                return this.negate(this.input(block, "OPERAND", "bool"));
            case "operator_join":
                return this.join(block);
            case "operator_letter_of": {
                const text = this.cast(this.input(block, "STRING", "str"), "str", true);
                return atom(`${wrap(text, ATOM)}[${this.input(block, "LETTER", "num").code}]`, "str");
            }
            case "operator_mathop": {
                const helper = mathHelpers[block.fields.OPERATOR?.[0] ?? ""];
                if (helper) return atom(`math.${helper}(${this.input(block, "NUM", "num").code})`, "num");
                break;
            }
            case "data_variable":
                return atom(this.varField(block, "VARIABLE"), "any");
            case "data_itemoflist":
                return atom(`${this.listField(block)}[${this.listIndex(block).code}]`, "any");
            case "argument_reporter_string_number":
            case "argument_reporter_boolean": {
                const param = this.params.get(block.fields.VALUE?.[0] ?? "");
                if (param) return atom(param.ident, param.ty);
                // Outside its define block an argument reports its type's empty value
                if (opcode === "argument_reporter_boolean") return atom("false", "bool", false);
                return strLit("");
            }
        }

        const entry = this.stdlib.byOpcode.get(opcode);
        if (entry && !entry.hat) return this.call(block, entry);
        // Unshadowed literal blocks (math_number, text, ...) only show up in hand-edited projects
        const field = Object.values(block.fields)[0]?.[0];
        if (/^(math_|text$|colour_picker$)/.test(opcode) && field != null) return scalarLit(field);
        this.notes.push(opcode);
        return strLit("");
    }

    /** Nested joins flatten into one f-string; literal text stays inline. */
    private join(block: Block): Expr {
        const parts: (string | Expr)[] = [];
        const collect = (b: Block) => {
            for (const name of ["STRING1", "STRING2"]) {
                const slot = b.inputs[name]?.[1] ?? null;
                const child = typeof slot === "string" ? (this.blocks[slot] as Block) : null;
                if (child?.opcode === "operator_join") collect(child);
                else if (Array.isArray(slot) && slot[0] !== 12 && slot[0] !== 13) parts.push(String(slot[1]));
                else if (slot !== null) parts.push(this.value(slot, "str"));
            }
        };
        collect(block);

        if (parts.every((p) => typeof p === "string")) return strLit(parts.join(""));
        const body = parts.map((p) => (typeof p === "string" ? escape(p).replace(/\{/g, "\\{") : `{${p.code}}`)).join("");
        return atom(`f"${body}"`, "str");
    }

    private procCall(block: Block): Expr {
        const mutation = block.mutation as ProcedureCallMutation;
        const info = this.procs.get(mutation.proccode);
        if (!info) {
            this.notes.push(`call to undefined block '${mutation.proccode}'`);
            return strLit("");
        }
        const ids: string[] = JSON.parse(mutation.argumentids);
        const args = info.params.map((p, i) => this.input(block, ids[i] ?? "", p.ty).code);
        return atom(`${info.name}(${args.join(", ")})`, "any");
    }

    /** A stdlib call, each sb3 slot read back into the param it came from. */
    private call(block: Block, entry: StdlibBlock): Expr {
        const slots = opcodeSlots[block.opcode];
        if (!slots || slots.length !== entry.params.length) {
            this.notes.push(block.opcode);
            return strLit("");
        }
        const args = slots.map((slot, i) => this.slotArg(block, slot, entry.params[i]!));
        const returns = tyOf(entry.returns);
        if (entry.method) {
            const [self, ...rest] = args;
            return atom(`${wrap(self!, ATOM)}.${entry.callee}(${rest.map((a) => a.code).join(", ")})`, returns);
        }
        return atom(`${entry.callee}(${args.map((a) => a.code).join(", ")})`, returns);
    }

    private slotArg(block: Block, slot: Slot, param: StdlibParam): Expr {
        const want = tyOf(param.type);
        switch (slot.kind) {
            case "input":
                return this.input(block, slot.name, want);
            case "field": {
                if (slot.ref === "variable") return atom(this.varField(block, slot.name), "any");
                if (slot.ref === "list") return atom(this.listField(block), "any");
                const value = block.fields[slot.name]?.[0] ?? "";
                if (slot.ref === "broadcast") return strLit(value);
                return this.option(value, param);
            }
            case "menu": {
                const inner = block.inputs[slot.name]?.[1] ?? null;
                const menu = typeof inner === "string" ? (this.blocks[inner] as Block | undefined) : undefined;
                if (menu?.shadow && menu.opcode === slot.menuOpcode)
                    return this.option(menu.fields[slot.menuField]?.[0] ?? slot.default, param);
                return this.cast(this.value(inner, want), want);
            }
            case "broadcast":
                return this.input(block, slot.name, "str");
        }
    }

    private option(value: string, param: StdlibParam): Expr {
        for (const e of param.enums) {
            const member = e.members.find((m) => String(m.value) === value);
            if (member) return atom(`${e.qualified}.${member.name}`, "any");
        }
        if (!takesText(param.type)) this.notes.push(`option '${value}' for ${param.name}`);
        return strLit(value);
    }
}
