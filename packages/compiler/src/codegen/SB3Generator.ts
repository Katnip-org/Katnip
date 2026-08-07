// import { zipSync } from 'fflate';

import { paramType, type IRExpr, type IRProc, type IRProgram, type IRScript, type IRStmt } from "../ir/IRNode.js";
import {
    minimalProject,
    minimalSprite,
    minimalStage,
    type Block,
    type BlockId,
    type BlockMap,
    type Input,
    type Sb3Project,
    type Sprite,
    type Target,
    type Uid,
} from "./SB3TypeDefs.js";

interface ProcSignature {
    proccode: string;
    argumentids: string[];
}

const typeSpec = { [paramType.BOOLEAN]: "%b", [paramType.STRING]: "%s", [paramType.NUMBER]: "%n" };
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

    private varIds = new Map<string, Uid>();
    private listIds = new Map<string, Uid>();
    private procSigs = new Map<string, ProcSignature>();

    constructor() {}

    generate(ir: IRProgram): Sb3Project {
        this.sb3 = minimalProject();
        this.varIds.clear();
        this.listIds.clear();
        this.procSigs.clear();

        const stage = minimalStage();
        this.sb3.targets.push(stage);
        this.declare(stage, ir.variables, ir.lists);

        let idx = 1;
        for (const ir_sprite of ir.sprites) {
            const sprite: Sprite = minimalSprite(ir_sprite.name, idx);
            this.sb3.targets.push(sprite);
            this.declare(sprite, ir_sprite.variables, ir_sprite.lists);
            sprite.blocks = this.processBlocks(ir_sprite.scripts);

            for (const proc of [...ir.procs.values(), ...ir_sprite.procs.values()])
                this.emitProc(proc, sprite.blocks);

            idx++;
        }

        return this.sb3;
    }

    private generateId(type: keyof typeof this.IDStore): string {
        const id = this.IDStore[type];
        this.IDStore[type]++;
        return `${type}${id}`;
    }

    /** Registers each name on the target and remembers its id, so references can resolve to it. */
    private declare(target: Target, variables: string[], lists: string[]): void {
        for (const name of variables) {
            const id = this.generateId("var");
            target.variables[id] = [name, 0];
            this.varIds.set(name, id);
        }
        for (const name of lists) {
            const id = this.generateId("list");
            target.lists[id] = [name, []];
            this.listIds.set(name, id);
        }
    }

    private newBlock(opcode: string, blocks: BlockMap, parent: BlockId | null, overrides: Partial<Block> = {}): [BlockId, Block] {
        const id = this.generateId("block");
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

        const [defId, def] = this.newBlock("procedures_definition", blocks, null, { topLevel: true, x: 0, y: 0 });
        const [protoId, proto] = this.newBlock("procedures_prototype", blocks, defId, { shadow: true });
        def.inputs.custom_block = [1, protoId];

        proc.params.forEach((param, i) => {
            const [reporterId, reporter] = this.newBlock(reporterOpcode(param.type), blocks, protoId, { shadow: true });
            reporter.fields.VALUE = [param.name, null];
            proto.inputs[sig.argumentids[i]!] = [1, reporterId];
        });

        proto.mutation = {
            tagName: "mutation",
            children: [],
            proccode: sig.proccode,
            argumentids: JSON.stringify(sig.argumentids),
            argumentnames: JSON.stringify(proc.params.map((p) => p.name)),
            argumentdefaults: JSON.stringify(proc.params.map((p) => (p.type === paramType.BOOLEAN ? false : ""))),
            // TODO: pull warp instead of default yes.
            warp: "yes",
        };

        // TODO: def.next = this.emitStack(proc.body, blocks, defId);
    }

    private signature(proc: IRProc): ProcSignature {
        let sig = this.procSigs.get(proc.name);
        if (!sig) {
            sig = {
                proccode: [proc.name, ...proc.params.map((p) => `${p.name} ${typeSpec[p.type]}`)].join(" "),
                argumentids: proc.params.map(() => this.generateId("var")),
            };
            this.procSigs.set(proc.name, sig);
        }
        return sig;
    }

    // --- TODO: everything below ---

    /** One top-level hat block per script; `applySlots` routes the hat args, `emitStack` the body. */
    private processBlocks(scripts: IRScript[]): BlockMap {
        const blockMap: BlockMap = {};
        
        void [this.emitStack, this.emitStmt, this.emitExpr, this.applySlots, this.input]; // TODO: remove this stub.
        return blockMap;
    }

    /** Emits a statement list as a linked stack, returning the first block id (null when empty). */
    private emitStack(stmts: IRStmt[], blocks: BlockMap, parent: BlockId | null): BlockId | null {
        throw new Error("TODO: chain each emitStmt through next/parent");
    }

    /** One IRStmt -> one block. */
    private emitStmt(stmt: IRStmt, blocks: BlockMap, parent: BlockId | null): BlockId {
        throw new Error(`TODO: emit ${stmt.kind}`);
    }

    /**
     * One IRExpr -> one reporter block.
     * `param` becomes an argument_reporter.
     * `stackref` becomes an item-of-list over the vstack.
     */
    private emitExpr(expr: IRExpr, blocks: BlockMap, parent: BlockId): BlockId {
        throw new Error(`TODO: emit ${expr.kind}`);
    }

    /** Routes positional IR inputs into the slots opcodeSlots declares for the opcode. */
    private applySlots(block: Block, id: BlockId, blocks: BlockMap, opcode: string, inputs: IRExpr[]): void {
        throw new Error(`TODO: route inputs for ${opcode}`);
    }

    /** Wraps an expression as an sb3 input value: [1, prim] for literals, [3, value, shadow] otherwise. */
    private input(expr: IRExpr, blocks: BlockMap, parent: BlockId, prim?: number): Input {
        throw new Error("TODO: serialize input");
    }
}
