import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { compile, expectClean } from "./helpers.js";
import { IRGenerator } from "../ir/IRGenerator.js";
import { SB3Generator } from "../codegen/SB3Generator.js";
import { packSb3 } from "../codegen/pack.js";
import { isBlock, type Block, type Sb3Project } from "../codegen/SB3TypeDefs.js";
import { booleanOpcodes } from "../codegen/scratchDefs.js";

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

/** A program dense enough to reach every emitter: loops, branches, calls, returns, an extension. */
const dense = `
public tally: num = 0;
public scores: list<num> = [3, 4];
public counts: dict<str, num> = {"a": 1, "b": bump(1, false)};
proc bump(n: num, loud: bool) -> num {
    if (loud) { looks.say("hi"); } else { looks.think("shh"); }
    return n + 1;
}
sprite Cat {
    private tally: num = 5;
    private paws: list<num> = [tally, 4];
    proc pounce(power: num) -> void { motion.forward(power); }
    events.onFlag() {
        pen.down();
        for (i, 3) { tally = bump(tally, true); }
        while (tally > 2) { tally = tally - 1; }
        scores[1] = scores[1] + 1;
        paws[2] += 1;
        counts["c"] = 2;
        for ((k, v), counts) { looks.say(k); tally += v; }
        pounce(tally);
    }
}
sprite Dog {
    events.onFlag() { tally = bump(1, false); }
}`;

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

test("packSb3 zips project.json and the default costume", () => {
    const project = build(`sprite Cat { proc greet(who: str) -> void { looks.say(who); } }`);
    const entries = unzipSync(packSb3(project));

    const costume = project.targets[0]!.costumes[0]!;
    assert.deepEqual(Object.keys(entries).sort(), ["project.json", costume.md5ext].sort());

    const parsed = JSON.parse(new TextDecoder().decode(entries["project.json"]!));
    assert.equal(parsed.targets[0].isStage, true);
    assert.equal(parsed.meta.semver, "3.0.0");

    // Scratch names each asset by the md5 of its bytes; a lossy embed breaks that.
    const md5 = createHash("md5").update(entries[costume.md5ext!]!).digest("hex");
    assert.equal(`${md5}.svg`, costume.md5ext);
    assert.equal(md5, costume.assetId);
});

test("every id a block references resolves", () => {
    const project = build(dense);
    const stage = project.targets[0]!;

    for (const target of project.targets) {
        // Globals live on the stage but are named from every target.
        const named = new Set([
            ...Object.keys(target.variables), ...Object.keys(target.lists), ...Object.keys(target.broadcasts),
            ...Object.keys(stage.variables), ...Object.keys(stage.lists), ...Object.keys(stage.broadcasts),
        ]);
        const blocks = target.blocks;
        const protos = new Set(
            Object.values(blocks)
                .filter(isBlock)
                .filter((b) => b.opcode === "procedures_prototype")
                .map((b) => (b.mutation as { proccode: string }).proccode),
        );

        for (const [id, block] of Object.entries(blocks)) {
            if (!isBlock(block)) continue;
            const at = `${target.name}/${id} ${block.opcode}`;

            if (block.next) assert(blocks[block.next], `${at}: next -> missing ${block.next}`);
            if (block.parent) assert(blocks[block.parent], `${at}: parent -> missing ${block.parent}`);
            assert.equal(block.topLevel, block.parent === null, `${at}: topLevel disagrees with parent`);

            for (const [slot, input] of Object.entries(block.inputs))
                for (const value of input.slice(1)) {
                    if (typeof value === "string") assert(blocks[value], `${at}.${slot} -> missing block ${value}`);
                    // Variable, list and broadcast primitives carry a registry id in slot 2.
                    else if (Array.isArray(value) && value.length > 2)
                        assert(named.has(value[2] as string), `${at}.${slot} -> unregistered ${value[2]}`);
                }

            for (const [slot, field] of Object.entries(block.fields))
                if (field[1]) assert(named.has(field[1]), `${at}.${slot} -> unregistered ${field[1]}`);

            if (block.opcode === "procedures_call") {
                const call = block.mutation as { proccode: string; warp: string };
                assert(protos.has(call.proccode), `${at}: no prototype for "${call.proccode}"`);
            }
        }
    }
});

test("a sprite local shadows a global only inside that sprite", () => {
    const project = build(dense);
    const [stage, cat, dog] = project.targets;

    // Scratch resolves stage and sprite names together, so a local keeping the global's
    // name would be discarded on load. It is renamed instead, and the shadowing still holds.
    const globalID = Object.entries(stage!.variables).find(([, v]) => v[0] === "tally")![0];
    const catID = Object.entries(cat!.variables).find(([, v]) => v[0] === "Cat_tally")![0];
    assert.notEqual(catID, globalID, "the sprite local should get its own id");
    assert(
        !Object.values(cat!.variables).some(([name]) => name === "tally"),
        "a sprite local must not reuse a global's name",
    );

    const reads = (target: typeof cat, id: string) =>
        Object.values(target!.blocks)
            .filter(isBlock)
            .some((b) => Object.values(b.fields).some((f) => f[1] === id));

    assert(reads(cat, catID), "Cat should reach its own tally");
    assert(!reads(cat, globalID), "Cat should not reach the global tally");
    assert(reads(dog, globalID), "Dog has no local, so it should reach the global");
});

test("extensions are declared for the blocks actually emitted", () => {
    assert.deepEqual(build(dense).extensions, ["pen"]);
    assert.deepEqual(build(`sprite Cat { events.onFlag() { looks.say("hi"); } }`).extensions, []);
});

test("a cap block ends its stack", () => {
    const blocks = blocksOf(build(`
        proc early(n: num) -> num { return n; looks.say("dead"); }
        sprite Cat { events.onFlag() { temp a: num = early(1); } }`));

    const [, stop] = find(blocks, "control_stop")!;
    assert.equal(stop.next, null);
    assert.equal((stop.mutation as { hasnext: string }).hasnext, "false");
    assert(!find(blocks, "looks_say"), "statements after a return should not be emitted");
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

test("declared lists reach target.lists with their literal contents", () => {
    const stage = build(`private scores: list<num> = [1, 2]; private cfg: dict<str, num> = {"a": 3};`).targets[0]!;
    const byName = Object.fromEntries(Object.values(stage.lists));

    assert.deepEqual(byName.scores, [1, 2]);
    assert.deepEqual(byName.cfg_keys, ["a"]);
    assert.deepEqual(byName.cfg_vals, [3]);
    assert(!Object.values(stage.variables).some(([name]) => name === "scores" || name === "cfg"));
});

test("a boolean slot never receives a round reporter", () => {
    // `flag` is a bool variable and `n > 0` is already hexagonal: only the first needs wrapping.
    const blocks = blocksOf(build(`
        proc want(loud: bool) -> void { if (loud) { looks.say("y"); } }
        sprite Cat {
            private flag: bool = true;
            events.onFlag() { want(flag); want(1 > 0); if (flag) { looks.say("x"); } }
        }`));

    const calls = Object.values(blocks).filter((b) => b.opcode === "procedures_call");
    assert.equal(calls.length, 2);

    for (const call of calls) {
        const [argId] = JSON.parse((call.mutation as { argumentids: string }).argumentids);
        const input = call.inputs[argId]!;
        const inner = blocks[input[1] as string]!;
        assert(
            booleanOpcodes.has(inner.opcode),
            `boolean parameter got ${inner.opcode}, which is not hexagonal`,
        );
    }

    // The `if` condition is a boolean slot too, so the bare variable is wrapped there as well.
    const branch = Object.values(blocks).find((b) => b.opcode === "control_if")!;
    assert.equal(blocks[branch.inputs.CONDITION![1] as string]!.opcode, "operator_equals");
});

test("a menu slot takes a shadow for a literal, and overlays a reporter for anything else", () => {
    const project = build(`sprite Cat {
        private where: str = "_mouse_";
        events.onFlag() { motion.goTo("_random_"); motion.goTo(where); }
    }`);
    const blocks = blocksOf(project);
    const [literal, computed] = Object.values(blocks).filter((b) => b.opcode === "motion_goto");

    // A literal is written straight into the menu shadow, which is all Scratch shows.
    const shadow = blocks[literal!.inputs.TO![1] as string]!;
    assert.deepEqual(literal!.inputs.TO, [1, literal!.inputs.TO![1]]);
    assert.equal(shadow.opcode, "motion_goto_menu");
    assert.equal(shadow.shadow, true);
    assert.deepEqual(shadow.fields.TO, ["_random_", null]);

    // A computed value covers the menu instead: [3, reporter, shadow], with the shadow
    // still holding a valid default, since Scratch reads it back when the reporter is pulled out.
    const [tag, reporter, under] = computed!.inputs.TO!;
    assert.equal(tag, 3);
    assert.equal(blocks[reporter as string]!.opcode, "data_variable");
    assert.deepEqual(blocks[under as string]!.fields.TO, ["_random_", null]);
});

test("broadcasts are registered on the stage and referenced as primitives", () => {
    const project = build(`sprite Cat {
        private topic: str = "later";
        events.onFlag() { events.broadcast("tally"); events.broadcast(topic); }
    }`);
    const blocks = blocksOf(project);
    const names = Object.values(project.targets[0]!.broadcasts);
    const [literal, computed] = Object.values(blocks).filter((b) => b.opcode === "event_broadcast");

    assert(names.includes("tally"), `"tally" should be registered, got ${names}`);

    const [tag, prim] = literal!.inputs.BROADCAST_INPUT!;
    assert.equal(tag, 1);
    assert.deepEqual((prim as [number, string, string]).slice(0, 2), [11, "tally"]);

    // A computed name still needs a real broadcast under it, or the project will not load.
    const [computedTag, reporter, under] = computed!.inputs.BROADCAST_INPUT!;
    assert.equal(computedTag, 3);
    assert.equal(blocks[reporter as string]!.opcode, "data_variable");
    assert(names.includes((under as [number, string, string])[1]), "the fallback shadow must name a registered broadcast");
});

test("stopping other scripts is not a cap block, so the stack continues", () => {
    const blocks = blocksOf(build(`sprite Cat {
        events.onFlag() { stop(StopType.OTHER_SCRIPTS_IN_SPRITE); looks.say("still here"); }
    }`));
    const [, stop] = find(blocks, "control_stop")!;

    // Scratch decides the block's shape from this mutation alone: "true" keeps the notch.
    assert.equal((stop.mutation as { hasnext: string }).hasnext, "true");
    assert.deepEqual(stop.fields.STOP_OPTION, ["other scripts in sprite", null]);
    assert.equal(blocks[stop.next!]!.opcode, "looks_say");
});

test("a for loop matches the shape the editor serializes control_for_each with", () => {
    const blocks = blocksOf(build(`sprite Cat { events.onFlag() { for (i, 3) { looks.say("hi"); } } }`));
    const [loopId, loop] = find(blocks, "control_for_each")!;

    // The counter binds through a VARIABLE field, and VALUE carries a text shadow.
    assert.equal(loop.fields.VARIABLE![0], "i");
    assert(loop.fields.VARIABLE![1], "the counter must resolve to a declared variable");
    assert.deepEqual(loop.inputs.VALUE, [1, [10, "3"]]);

    const [sayId, say] = find(blocks, "looks_say")!;
    assert.deepEqual(loop.inputs.SUBSTACK, [2, sayId]);
    assert.equal(say.parent, loopId);
});
