// import { zipSync } from 'fflate';

import type { IRProgram, IRScript } from "../ir/IRNode.js";
import { minimalProject, minimalSprite, minimalStage, type BlockMap, type Sb3Project, type Sprite } from "./SB3TypeDefs.js";

export class SB3Generator {
    private sb3: Sb3Project = minimalProject();
    private IDStore = {
        var: 0,
        list: 0,
        block: 0,
        comment: 0,
        broadcast: 0,
    }

    constructor() {}

    generate(ir: IRProgram): any {
        this.sb3 = minimalProject();
        this.sb3.targets.push(minimalStage());

        let sprite: Sprite = minimalSprite("", 1);
        let idx = 1;
        for (const ir_sprite of ir.sprites) {
            sprite = minimalSprite(ir_sprite.name, idx);
            sprite.blocks = this.processBlocks(ir_sprite.scripts);
            ir_sprite.lists.forEach((list) => {
                sprite.lists[this.generateId("list")] = [list, []];
            });
            ir_sprite.variables.forEach((variable) => {
                sprite.variables[this.generateId("var")] = [variable, 0];
            });
            idx++;
        }

        return this.sb3;
    }

    private generateId(type: keyof typeof this.IDStore): string {
        const id = this.IDStore[type];
        this.IDStore[type]++;
        return id.toString();
    }

    private processBlocks(blocks: IRScript[]): BlockMap {
        const blockMap: BlockMap = {};
        return blockMap;
    }
}
