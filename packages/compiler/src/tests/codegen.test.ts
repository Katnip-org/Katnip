import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, expectClean } from "./helpers.js";
import { IRGenerator } from "../ir/IRGenerator.js";
import { SB3Generator } from "../codegen/SB3Generator.js";
import { isBlock, type Block, type Sb3Project } from "../codegen/SB3TypeDefs.js";

function build(source: string): Sb3Project {
    const result = compile(source, { stdlib: true });
    expectClean(result);
    const ir = new IRGenerator(result.analyzer).generate(result.ast);
    return new SB3Generator().generate(ir);
}

function blocksOf(project: Sb3Project, target = 1): Record<string, Block> {
    const entries = Object.entries(project.targets[target]!.blocks).filter(([, b]) => isBlock(b));
    return Object.fromEntries(entries) as Record<string, Block>;
}

const find = (blocks: Record<string, Block>, opcode: string) =>
    Object.entries(blocks).find(([, b]) => b.opcode === opcode);

test("proc definition emits a prototype, mutation and argument reporters", () => {
    const blocks = blocksOf(build(`sprite Cat { proc greet(who: str, times: num) -> void { looks.say(who); } }`));

    const [defId, def] = find(blocks, "procedures_definition")!;
    assert.equal(def.topLevel, true);
    assert.equal(def.parent, null);

    const custom = def.inputs.custom_block!;
    assert.equal(custom[0], 1);
    const protoId = custom[1] as string;
    const proto = blocks[protoId]!;
    assert.equal(proto.opcode, "procedures_prototype");
    assert.equal(proto.shadow, true);
    assert.equal(proto.parent, defId);

    const mutation = proto.mutation as any;
    assert.equal(mutation.proccode, "greet who %s times %n");
    assert.deepEqual(JSON.parse(mutation.argumentnames), ["who", "times"]);
    assert.deepEqual(JSON.parse(mutation.argumentdefaults), ["", ""]);

    const argumentids: string[] = JSON.parse(mutation.argumentids);
    assert.equal(argumentids.length, 2);
    for (const [i, argId] of argumentids.entries()) {
        const reporter = blocks[proto.inputs[argId]![1] as string]!;
        assert.equal(reporter.opcode, "argument_reporter_string_number");
        assert.equal(reporter.shadow, true);
        assert.equal(reporter.parent, protoId);
        assert.deepEqual(reporter.fields.VALUE, [["who", "times"][i], null]);
    }
});

test("proc ret vars and script temps reach a target's variable map", () => {
    const project = build(
        `sprite Cat { proc addone(x: num) -> num { return x + 1; } events.onFlag() { temp y = addone(2); } }`,
    );
    const declared = project.targets.flatMap((t) => Object.values(t.variables).map((v) => v[0]));
    assert(declared.includes("addone_ret"), `ret var missing from ${declared}`);
    assert(declared.includes("y"), `script temp missing from ${declared}`);
});

test("ids are unique across the var, list and block namespaces", () => {
    const project = build(`sprite Cat { proc greet(who: str) -> void { looks.say(who); } }`);
    const ids = project.targets.flatMap((t) => [
        ...Object.keys(t.variables),
        ...Object.keys(t.lists),
        ...Object.keys(t.blocks),
    ]);
    assert.equal(new Set(ids).size, ids.length, "duplicate id across namespaces");
});
