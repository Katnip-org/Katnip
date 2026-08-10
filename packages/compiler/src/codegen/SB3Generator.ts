// import { zipSync } from 'fflate';

import { paramType, type IRExpr, type IRParam, type IRProc, type IRProgram, type IRScript, type IRStmt } from "../ir/IRNode.js";
import {
    minimalProject,
    minimalSprite,
    minimalStage,
    type Block,
    type BlockId,
    type BlockMap,
    type Input,
    type KnownExtension,
    type Primitive,
    type Sb3Project,
    type Scalar,
    type Sprite,
    type StopMutation,
    type Target,
    type Uid,
} from "./SB3TypeDefs.js";
import { booleanOpcodes, opcodeSlots, type ShadowPrimitiveType } from "./scratchDefs.js";
import { KatnipError } from "../utils/ErrorReporter.js";

interface ProcSignature {
    proccode: string;
    argumentids: string[];
    types: paramType[];
    warp: string;
}

const typeSpec = { [paramType.BOOLEAN]: "%b", [paramType.STRING]: "%s", [paramType.NUMBER]: "%n" };

const proccodeOf = (proc: IRProc): string => {
    if (proc.proccode === undefined)
        return [proc.name, ...proc.params.map((p) => `${p.name} ${typeSpec[p.type]}`)].join(" ");

    let i = 0;
    return proc.proccode.replace(/%[A-Za-z_][A-Za-z_0-9]*/g, () => typeSpec[(proc.params[i++] as IRParam).type]);
};

const boolLit = (value: string | number | boolean): IRExpr => ({
    kind: "op",
    opcode: "operator_equals",
    inputs: [
        { kind: "lit", value: value ? "true" : "false" },
        { kind: "lit", value: value ? "true" : "" },
    ],
});

/**
 * Wraps a round reporter so it fits a hexagonal slot. Katnip stores a bool as the string
 * Scratch itself reports, so comparing against "true" round-trips the value unchanged.
 */
const boolCast = (expr: IRExpr): IRExpr => ({
    kind: "op",
    opcode: "operator_equals",
    inputs: [expr, { kind: "lit", value: "true" }],
});

const stackItem = (ref: Extract<IRExpr, { kind: "stackref" }>): IRExpr => {
    const list: IRExpr = { kind: "var", name: ref.list };
    const index: IRExpr =
        ref.depth === 0
            ? { kind: "lit", value: "last" }
            : {
                  kind: "op",
                  opcode: "operator_subtract",
                  inputs: [
                      { kind: "op", opcode: "data_lengthoflist", inputs: [list] },
                      { kind: "lit", value: ref.depth },
                  ],
              };
    return { kind: "op", opcode: "data_itemoflist", inputs: [list, index] };
};

const defaultBroadcast = "message1";
const topLevelGap = 400;

/** Opcode prefixes Scratch will not load unless the project declares them. */
const extensionIDs = new Set<KnownExtension>([
    "pen", "music", "text2speech", "translate", "videoSensing",
    "makeymakey", "microbit", "ev3", "boost", "wedo2", "gdxfor",
]);

const isCap = (block: Block): boolean => {
    if (block.opcode === "control_forever" || block.opcode === "control_delete_this_clone") return true;
    return block.opcode === "control_stop" && (block.mutation as StopMutation).hasnext === "false";
};

const argPrim = (type: paramType): ShadowPrimitiveType | undefined => {
    if (type === paramType.BOOLEAN) return undefined;
    if (type === paramType.NUMBER) return 4;
    return 10;
};

const stopMutation = (option: IRExpr): StopMutation => {
    if (option.kind !== "lit") throw new KatnipError("Codegen","control_stop needs a literal option");
    return { tagName: "mutation", children: [], hasnext: String(option.value === "other scripts in sprite") };
};

const reporterOpcode = (type: paramType) =>
    type === paramType.BOOLEAN ? "argument_reporter_boolean" : "argument_reporter_string_number";

export class SB3Generator {
    private sb3: Sb3Project = minimalProject();
    private IDStore = {
        var: 0,
        list: 0,
        block: 0,
        comment: 0,
        broadcast: 0,
    }

    private varIDs = new Map<string, Uid>();
    private listIDs = new Map<string, Uid>();
    private procSigs = new Map<string, ProcSignature>();
    private broadcastIDs = new Map<string, Uid>();
    private params = new Map<string, paramType>();
    private used = new Set<KnownExtension>();
    private topY = 0;

    constructor() {}

    generate(ir: IRProgram): Sb3Project {
        this.sb3 = minimalProject();
        this.varIDs.clear();
        this.listIDs.clear();
        this.procSigs.clear();
        this.broadcastIDs.clear();

        this.used.clear();

        const stage = minimalStage();
        this.sb3.targets.push(stage);
        this.declare(stage, ir.variables, ir.lists);

        // Globals stay visible from every sprite; a sprite-local of the same name shadows them.
        const globalVars = new Map(this.varIDs);
        const globalLists = new Map(this.listIDs);

        // Every signature up front, so a call emitted before its definition still resolves.
        for (const sprite of ir.sprites) for (const proc of sprite.procs.values()) this.signature(proc);
        for (const proc of ir.procs.values()) this.signature(proc);

        let idx = 1;
        for (const ir_sprite of ir.sprites) {
            const sprite: Sprite = minimalSprite(ir_sprite.name, idx);
            this.sb3.targets.push(sprite);
            this.varIDs = new Map(globalVars);
            this.listIDs = new Map(globalLists);
            this.declare(sprite, ir_sprite.variables, ir_sprite.lists);
            this.topY = 0;
            sprite.blocks = this.processBlocks(ir_sprite.scripts);

            for (const proc of [...ir.procs.values(), ...ir_sprite.procs.values()])
                this.emitProc(proc, sprite.blocks);

            idx++;
        }

        this.sb3.extensions = [...this.used];
        return this.sb3;
    }

    private generateID(type: keyof typeof this.IDStore): string {
        const id = this.IDStore[type];
        this.IDStore[type]++;
        return `${type}${id}`;
    }

    /** Registers each name on the target and remembers its id, so references can resolve to it. */
    private declare(target: Target, variables: Map<string, Scalar>, lists: Map<string, Scalar[]>): void {
        for (const [name, value] of variables) {
            const id = this.generateID("var");
            target.variables[id] = [name, value];
            this.varIDs.set(name, id);
        }
        for (const [name, contents] of lists) {
            const id = this.generateID("list");
            target.lists[id] = [name, contents];
            this.listIDs.set(name, id);
        }
    }

    private newBlock(opcode: string, blocks: BlockMap, parent: BlockId | null, overrides: Partial<Block> = {}): [BlockId, Block] {
        const id = this.generateID("block");
        const prefix = opcode.split("_")[0] as KnownExtension;
        if (extensionIDs.has(prefix)) this.used.add(prefix);

        blocks[id] = {
            opcode,
            next: null,
            parent,
            inputs: {},
            fields: {},
            shadow: false,
            topLevel: false,
            ...overrides,
        };
        return [id, blocks[id] as Block];
    }

    private emitProc(proc: IRProc, blocks: BlockMap): void {
        const sig = this.signature(proc);
        this.params = new Map(proc.params.map((p) => [p.name, p.type]));

        const [defID, def] = this.newBlock("procedures_definition", blocks, null, { topLevel: true, x: 0, y: this.topY });
        this.topY += topLevelGap;
        const [protoID, proto] = this.newBlock("procedures_prototype", blocks, defID, { shadow: true });
        def.inputs.custom_block = [1, protoID];

        proc.params.forEach((param, i) => {
            const [reporterID, reporter] = this.newBlock(reporterOpcode(param.type), blocks, protoID, { shadow: true });
            reporter.fields.VALUE = [param.name, null];
            proto.inputs[sig.argumentids[i]!] = [1, reporterID];
        });

        proto.mutation = {
            tagName: "mutation",
            children: [],
            proccode: sig.proccode,
            argumentids: JSON.stringify(sig.argumentids),
            argumentnames: JSON.stringify(proc.params.map((p) => p.name)),
            argumentdefaults: JSON.stringify(proc.params.map((p) => (p.type === paramType.BOOLEAN ? false : ""))),
            warp: sig.warp,
        };

        def.next = this.emitStack(proc.body, blocks, defID);
    }

    private signature(proc: IRProc): ProcSignature {
        let sig = this.procSigs.get(proc.name);
        if (!sig) {
            sig = {
                proccode: proccodeOf(proc),
                argumentids: proc.params.map(() => this.generateID("var")),
                types: proc.params.map((p) => p.type),
                // The sb3 schema rejects anything but "true"/"false".
                warp: String(proc.warp),
            };
            this.procSigs.set(proc.name, sig);
        }
        return sig;
    }

    /** One top-level hat block per script; `applySlots` routes the hat args, `emitStack` the body. */
    private processBlocks(scripts: IRScript[]): BlockMap {
        const blocks: BlockMap = {};
        this.params.clear(); // A script has no params, so an argument reporter here is a bug.

        for (const script of scripts) {
            const [id, hat] = this.newBlock(script.hatOpcode, blocks, null, { topLevel: true, x: 0, y: this.topY });
            this.topY += topLevelGap;
            this.applySlots(hat, id, blocks, script.hatOpcode, script.args);
            hat.next = this.emitStack(script.body, blocks, id);
        }
        return blocks;
    }

    /** Emits a statement list as a linked stack, returning the first block id (null when empty). */
    private emitStack(stmts: IRStmt[], blocks: BlockMap, parent: BlockId | null): BlockId | null {
        let first: BlockId | null = null;
        let prev: BlockId | null = null;

        for (const stmt of stmts) {
            const id = this.emitStmt(stmt, blocks, prev ?? parent);
            if (prev) (blocks[prev] as Block).next = id;
            else first = id;
            prev = id;
            if (isCap(blocks[id] as Block)) break;
        }
        return first;
    }

    /** Attaches a branch as a SUBSTACK. An empty branch has no input at all, the way sb3 stores it. */
    private substack(block: Block, name: string, body: IRStmt[], blocks: BlockMap, parent: BlockId): void {
        const first = this.emitStack(body, blocks, parent);
        if (first) block.inputs[name] = [2, first];
    }

    /** One IRStmt -> one block. */
    private emitStmt(stmt: IRStmt, blocks: BlockMap, parent: BlockId | null): BlockId {
        switch (stmt.kind) {
            case "raw": {
                const [id, block] = this.newBlock(stmt.opcode, blocks, parent);
                this.applySlots(block, id, blocks, stmt.opcode, stmt.inputs);
                if (stmt.opcode === "control_stop") block.mutation = stopMutation(stmt.inputs[0]!);
                return id;
            }
            case "call": {
                const sig = this.procSigs.get(stmt.proc);
                if (!sig) throw new KatnipError("Codegen",`call to unknown proc '${stmt.proc}'`);

                const [id, block] = this.newBlock("procedures_call", blocks, parent);
                stmt.args.forEach((arg, i) => {
                    block.inputs[sig.argumentids[i]!] = this.input(arg, blocks, id, argPrim(sig.types[i]!));
                });
                block.mutation = {
                    tagName: "mutation",
                    children: [],
                    proccode: sig.proccode,
                    argumentids: JSON.stringify(sig.argumentids),
                    warp: sig.warp,
                };
                return id;
            }
            case "if": {
                let opcode = "control_if";
                if (stmt.else.length > 0) opcode = "control_if_else";

                const [id, block] = this.newBlock(opcode, blocks, parent);
                block.inputs.CONDITION = this.input(stmt.cond, blocks, id);
                this.substack(block, "SUBSTACK", stmt.then, blocks, id);
                this.substack(block, "SUBSTACK2", stmt.else, blocks, id);
                return id;
            }
            case "while": {
                const [id, block] = this.newBlock("control_while", blocks, parent);
                block.inputs.CONDITION = this.input(stmt.cond, blocks, id);
                this.substack(block, "SUBSTACK", stmt.body, blocks, id);
                return id;
            }
            case "repeat": {
                const [id, block] = this.newBlock("control_repeat", blocks, parent);
                block.inputs.TIMES = this.input(stmt.times, blocks, id, 6);
                this.substack(block, "SUBSTACK", stmt.body, blocks, id);
                return id;
            }
            case "for": {
                const [id, block] = this.newBlock("control_for_each", blocks, parent);
                const varID = this.varIDs.get(stmt.iter);
                if (!varID) throw new KatnipError("Codegen",`undeclared variable '${stmt.iter}'`);

                block.fields.VARIABLE = [stmt.iter, varID];
                // The editor serializes this shadow as text, so match it rather than a number.
                block.inputs.VALUE = this.input(stmt.times, blocks, id, 10);
                this.substack(block, "SUBSTACK", stmt.body, blocks, id);
                return id;
            }
            case "forever": {
                const [id, block] = this.newBlock("control_forever", blocks, parent);
                this.substack(block, "SUBSTACK", stmt.body, blocks, id);
                return id;
            }
        }
    }

    /**
     * One IRExpr -> one reporter block.
     * `param` becomes an argument_reporter.
     * `stackref` becomes an item-of-list over the vstack.
     */
    private emitExpr(expr: IRExpr, blocks: BlockMap, parent: BlockId): BlockId {
        switch (expr.kind) {
            case "op": {
                const [id, block] = this.newBlock(expr.opcode, blocks, parent);
                this.applySlots(block, id, blocks, expr.opcode, expr.inputs);
                return id;
            }
            case "param": {
                const type = this.params.get(expr.name);
                if (type === undefined) throw new KatnipError("Codegen",`'${expr.name}' is not a param of the current proc`);
                const [id, block] = this.newBlock(reporterOpcode(type), blocks, parent);
                block.fields.VALUE = [expr.name, null];
                return id;
            }
            case "stackref":
                return this.emitExpr(stackItem(expr), blocks, parent);
            // `input` compresses a var to a [12, name, id] primitive, this is the unprocessed form.
            case "var": {
                const varID = this.varIDs.get(expr.name);
                if (!varID) throw new KatnipError("Codegen",`undeclared variable '${expr.name}'`);
                const [id, block] = this.newBlock("data_variable", blocks, parent);
                block.fields.VARIABLE = [expr.name, varID];
                return id;
            }
            case "lit":
                throw new KatnipError("Codegen","lit has no block form");
        }
    }

    /** Routes positional IR inputs into the slots opcodeSlots declares for the opcode. */
    private applySlots(block: Block, id: BlockId, blocks: BlockMap, opcode: string, inputs: IRExpr[]): void {
        const slots = opcodeSlots[opcode];
        if (!slots) throw new KatnipError("Codegen",`no slot metadata for '${opcode}'`);
        if (inputs.length !== slots.length)
            throw new KatnipError("Codegen",`${opcode} takes ${slots.length} inputs, got ${inputs.length}`);

        slots.forEach((slot, i) => {
            const expr = inputs[i]!;
            switch (slot.kind) {
                case "input":
                    block.inputs[slot.name] = this.input(expr, blocks, id, slot.prim);
                    break;
                case "field": {
                    if (!slot.ref) {
                        if (expr.kind !== "lit")
                            throw new KatnipError("Codegen",`${opcode}.${slot.name} needs a constant, got ${expr.kind}`);
                        block.fields[slot.name] = [String(expr.value), null];
                        break;
                    }
                    
                    const name = expr.kind === "var" ? expr.name : expr.kind === "lit" ? String(expr.value) : null;
                    if (name === null)
                        throw new KatnipError("Codegen",`${opcode}.${slot.name} needs a ${slot.ref} name, got ${expr.kind}`);

                    let refID;
                    if (slot.ref === "broadcast") refID = this.broadcastID(name);
                    else if (slot.ref === "list") refID = this.listIDs.get(name);
                    else refID = this.varIDs.get(name);

                    if (!refID) throw new KatnipError("Codegen",`undeclared ${slot.ref} '${name}'`);
                    block.fields[slot.name] = [name, refID];
                    break;
                }
                case "menu": {
                    const [menuID, menu] = this.newBlock(slot.menuOpcode, blocks, id, { shadow: true });
                    if (expr.kind === "lit") {
                        menu.fields[slot.menuField] = [String(expr.value), null];
                        block.inputs[slot.name] = [1, menuID];
                    } else {
                        menu.fields[slot.menuField] = [slot.default, null];
                        block.inputs[slot.name] = [3, this.emitExpr(expr, blocks, id), menuID];
                    }
                    break;
                }
                case "broadcast": {
                    if (expr.kind === "lit") {
                        const name = String(expr.value);
                        block.inputs[slot.name] = [1, [11, name, this.broadcastID(name)]];
                        break;
                    }
                    // The shadow under a computed name still has to name a real broadcast.
                    const shadow: Primitive = [11, defaultBroadcast, this.broadcastID(defaultBroadcast)];
                    block.inputs[slot.name] = [3, this.emitExpr(expr, blocks, id), shadow];
                    break;
                }
            }
        });
    }

    /** Broadcasts are registered on the stage, whichever target uses them. */
    private broadcastID(name: string): Uid {
        let id = this.broadcastIDs.get(name);
        if (!id) {
            id = this.generateID("broadcast");
            this.broadcastIDs.set(name, id);
            this.sb3.targets[0]!.broadcasts[id] = name;
        }
        return id;
    }

    /** Wraps an expression as an sb3 input value: [1, prim] for literals, [3, value, shadow] otherwise. */
    private input(expr: IRExpr, blocks: BlockMap, parent: BlockId, prim?: ShadowPrimitiveType): Input {
        // A color shadow must be a valid #rrggbb, unlike every other prim where "" is fine.
        const shadow = prim ? ([prim, prim === 9 ? "#000000" : ""] as Primitive) : null;

        // No prim means a boolean slot, which is hexagonal and rejects a round reporter.
        if (!prim && expr.kind !== "lit" && !this.isBoolShaped(expr))
            return this.input(boolCast(expr), blocks, parent);

        switch (expr.kind) {
            case "lit":
                if (!prim) return this.input(boolLit(expr.value), blocks, parent);
                return [1, [prim, String(expr.value)] as Primitive];
            case "var": {
                const id = this.varIDs.get(expr.name);
                if (!id) throw new KatnipError("Codegen",`undeclared variable '${expr.name}'`);
                return [3, [12, expr.name, id], shadow];
            }
            case "op":
            case "param":
            case "stackref": {
                const id = this.emitExpr(expr, blocks, parent);
                return shadow ? [3, id, shadow] : [2, id];
            }
        }
    }

    /** Whether an expression already emits a hexagonal block, so a boolean slot takes it as-is. */
    private isBoolShaped(expr: IRExpr): boolean {
        if (expr.kind === "op") return booleanOpcodes.has(expr.opcode);
        if (expr.kind === "param") return this.params.get(expr.name) === paramType.BOOLEAN;
        return false;
    }
}
