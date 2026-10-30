import { test } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { checkSource, compileToSb3, decompileProject, decompileSb3 } from "../index.js";
import { minimalProject, minimalSprite, minimalStage, type Block, type BlockMap, type Scalar } from "../codegen/SB3TypeDefs.js";

function build(source: string): Uint8Array {
    const { errors, sb3 } = compileToSb3(source);
    assert.ok(sb3, errors.map((e) => e.message).join("\n"));
    return sb3;
}

function expectChecks(knip: string): void {
    const errors = checkSource(knip).filter((e) => e.severity === "error");
    assert.deepEqual(errors.map((e) => `${e.message} @${e.location?.line}`), [], knip);
}

function opcodes(sb3: Uint8Array): Set<string> {
    const project = JSON.parse(strFromU8(unzipSync(sb3)["project.json"]!));
    return new Set(project.targets.flatMap((t: { blocks: BlockMap }) =>
        Object.values(t.blocks).flatMap((b) => ("opcode" in b ? [b.opcode] : []))));
}

const dense = `
public score: num = 0;
public names: list<str> = ["a", "b"];

sprite Cat {
    private lives: num = 9;

    proc hop(@warp = true, height: num, loud: bool) -> void {
        motion.changeY(height);
        if (loud) { looks.say("hop"); }
    }

    events.onFlag() {
        motion.goTo(0, 0);
        motion.point(motion.Target.MOUSE);
        looks.setEffect(looks.GraphicEffect.GHOST, 50);
        hop(10, true);
        forever {
            if (sensing.keyPressed(Key.SPACE) && !sensing.mouseDown()) { lives -= 1; }
            elif (score > 10) { stop(StopType.ALL); }
            else { wait(math.random(1, 3)); }
        }
    }
    events.onKey(Key.a) {
        names.add(f"lives: {lives}");
        looks.say(names[1]);
        score = math.sqrt(len("abc"));
    }
    events.onBroadcast("go") {
        while (lives < 3) { lives += 1; }
        clone.create(clone.CloneTarget.MYSELF);
    }
    clone.onStart() { clone.delete(); }
}
`;

test("a compiled project decompiles to source that rebuilds the same blocks", () => {
    const sb3 = build(dense);
    const knip = decompileSb3(sb3);
    expectChecks(knip);
    assert.deepEqual(opcodes(build(knip)), opcodes(sb3));

    assert.match(knip, /public score: any = 0;/);
    assert.match(knip, /public names: list<any> = \["a", "b"\];/);
    assert.match(knip, /proc hop\(@warp = true, height: any, loud: bool\) -> void \{/);
    assert.match(knip, /\} elif \(score > 10\) \{/);
    assert.match(knip, /names\.add\(f"lives: \{lives\}"\);/);
    assert.match(knip, /events\.onKey\(Key\.a\) \{/);
    assert.match(knip, /clone\.create\(clone\.CloneTarget\.MYSELF\);/);
    assert.doesNotMatch(knip, /_tempKeys/);
});

test("Scratch-only blocks and names are translated or flagged", () => {
    const blocks: BlockMap = {
        hat: { opcode: "event_whenflagclicked", next: "rep", parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0 },
        rep: { opcode: "control_repeat", next: "until", parent: "hat", inputs: { TIMES: [1, [6, "10"]], SUBSTACK: [2, "move"] }, fields: {}, shadow: false, topLevel: false },
        move: { opcode: "motion_movesteps", next: null, parent: "rep", inputs: { STEPS: [1, [4, "5"]] }, fields: {}, shadow: false, topLevel: false },
        until: { opcode: "control_repeat_until", next: "wait", parent: "rep", inputs: { CONDITION: [2, "touch"], SUBSTACK: [2, "say"] }, fields: {}, shadow: false, topLevel: false },
        touch: { opcode: "sensing_touchingobject", next: null, parent: "until", inputs: { TOUCHINGOBJECTMENU: [1, "menu"] }, fields: {}, shadow: false, topLevel: false },
        menu: { opcode: "sensing_touchingobjectmenu", next: null, parent: "touch", inputs: {}, fields: { TOUCHINGOBJECTMENU: ["_edge_", null] }, shadow: true, topLevel: false },
        say: { opcode: "looks_say", next: null, parent: "until", inputs: { MESSAGE: [3, [12, "my var", "v1"], [10, ""]] }, fields: {}, shadow: false, topLevel: false },
        wait: { opcode: "control_wait_until", next: "note", parent: "until", inputs: {}, fields: {}, shadow: false, topLevel: false },
        note: { opcode: "music_playNoteForBeats", next: null, parent: "wait", inputs: {}, fields: {}, shadow: false, topLevel: false },
    };
    const sprite = { ...minimalSprite("Sprite 1", 1), blocks };
    sprite.variables = { v1: ["my var", "hello"] };
    const project = { ...minimalProject(), targets: [minimalStage(), sprite] };

    const knip = decompileProject(project);
    expectChecks(knip.replace(/^\s*# unsupported.*\n/gm, ""));
    assert.match(knip, /sprite Sprite_1 \{\n    private my_var: any = "hello";/);
    assert.match(knip, /repeat \(10\) \{\n\s+motion\.forward\(5\);\n\s+\}/);
    assert.match(knip, /while \(!sensing\.touching\(sensing\.TouchTarget\.EDGE\)\) \{\n\s+looks\.say\(my_var\);/);
    assert.match(knip, /while \(true\) \{\}/);
    assert.match(knip, /# unsupported: music_playNoteForBeats/);
});

type Partial = { opcode: string } & Record<string, unknown>;

/** A one-sprite project from terse blocks; `next`/`parent` default to null, the rest to empty. */
function project(blocks: Record<string, Partial>, variables: Record<string, [string, Scalar]> = {}, lists: Record<string, [string, Scalar[]]> = {}) {
    const full: BlockMap = {};
    for (const [id, b] of Object.entries(blocks))
        full[id] = { next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: false, ...b } as Block;
    const sprite = { ...minimalSprite("S", 1), blocks: full, variables, lists };
    return { ...minimalProject(), targets: [minimalStage(), sprite] };
}

/** `define p` (warp) running `body`, plus a green-flag script that calls it. */
function procProject(body: Record<string, Partial>, first: string, variables: Record<string, [string, Scalar]>, lists = {}) {
    const mutation = { tagName: "mutation", children: [], proccode: "p", argumentids: "[]", warp: "true" };
    return project({
        def: { opcode: "procedures_definition", next: first, inputs: { custom_block: [1, "proto"] }, topLevel: true, x: 0, y: 0 },
        proto: { opcode: "procedures_prototype", shadow: true, mutation: { ...mutation, argumentnames: "[]", argumentdefaults: "[]" } },
        hat: { opcode: "event_whenflagclicked", next: "call", topLevel: true, x: 0, y: 500 },
        call: { opcode: "procedures_call", mutation },
        ...body,
    }, variables, lists);
}

test("a trailing stop is dropped and number text is cleaned up", () => {
    const stop = { opcode: "control_stop", fields: { STOP_OPTION: ["this script", null] }, mutation: { tagName: "mutation", children: [], hasnext: "false" } };
    const knip = decompileProject(procProject({
        move: { opcode: "motion_movesteps", next: "end", inputs: { STEPS: [3, "add", [4, ""]] } },
        add: { opcode: "operator_add", inputs: { NUM1: [1, [4, "1.50"]], NUM2: [1, [4, "2"]] } },
        end: stop,
    }, "move", {}));
    expectChecks(knip);
    assert.match(knip, /proc p\(@warp = true\) -> void \{\n {8}motion\.forward\(1\.5 \+ 2\);\n {4}\}/);
});

test("a stop that isn't last, or stops more than this script, is kept", () => {
    const stop = (option: string) => ({ opcode: "control_stop", fields: { STOP_OPTION: [option, null] }, mutation: { tagName: "mutation", children: [], hasnext: "false" } });
    const knip = decompileProject(procProject({
        if: { opcode: "control_if", next: "all", inputs: { CONDITION: [2, "down"], SUBSTACK: [2, "early"] } },
        down: { opcode: "sensing_mousedown" },
        early: stop("this script"),
        all: stop("all"),
    }, "if", {}));
    expectChecks(knip);
    assert.match(knip, /if \(sensing\.mouseDown\(\)\) \{\n {12}stop\(StopType\.THIS_SCRIPT\);\n {8}\}\n {8}stop\(StopType\.ALL\);/);
});

test("else holding only an if becomes elif", () => {
    const knip = decompileProject(procProject({
        if: { opcode: "control_if_else", inputs: { CONDITION: [2, "a"], SUBSTACK: [2, "s1"], SUBSTACK2: [2, "if2"] } },
        a: { opcode: "sensing_mousedown" },
        s1: { opcode: "looks_show" },
        if2: { opcode: "control_if_else", inputs: { CONDITION: [2, "b"], SUBSTACK: [2, "s2"], SUBSTACK2: [2, "s3"] } },
        b: { opcode: "operator_not", inputs: { OPERAND: [2, "eq"] } },
        eq: { opcode: "operator_equals", inputs: { OPERAND1: [3, [12, "v", "v1"], [10, ""]], OPERAND2: [1, [10, "2"]] } },
        s2: { opcode: "looks_hide" },
        s3: { opcode: "pen_clear" },
    }, "if", { v1: ["v", 0] }));
    expectChecks(knip);
    assert.match(knip, /if \(sensing\.mouseDown\(\)\) \{\n {12}looks\.show\(\);\n {8}\} elif \(v != 2\) \{\n {12}looks\.hide\(\);\n {8}\} else \{\n {12}pen\.clear\(\);\n {8}\}/);
});

test("list indices, joins and casts", () => {
    const knip = decompileProject(procProject({
        say: { opcode: "looks_say", next: "del", inputs: { MESSAGE: [3, "join", [10, ""]] } },
        join: { opcode: "operator_join", inputs: { STRING1: [1, [10, "n={"]], STRING2: [3, "item", [10, ""]] } },
        item: { opcode: "data_itemoflist", fields: { LIST: ["li", "l1"] }, inputs: { INDEX: [1, [7, "last"]] } },
        del: { opcode: "data_deleteoflist", next: "move", fields: { LIST: ["li", "l1"] }, inputs: { INDEX: [1, [7, "all"]] } },
        move: { opcode: "motion_movesteps", inputs: { STEPS: [3, "len", [4, ""]] } },
        len: { opcode: "operator_length", inputs: { STRING: [3, [12, "v", "v1"], [10, ""]] } },
    }, "say", { v1: ["v", "abc"] }, { l1: ["li", [1, 2]] }));
    expectChecks(knip);
    assert.match(knip, /looks\.say\(f"n=\\\{\{li\[li\.length\(\)\]\}"\);/);
    assert.match(knip, /li\.clear\(\);/);
    assert.match(knip, /motion\.forward\(len\(v\)\);/);
});

test("a repeat count the loop body changes is read once, like Scratch does", () => {
    const knip = decompileProject(procProject({
        rep: { opcode: "control_repeat", inputs: { TIMES: [3, "len", [6, ""]], SUBSTACK: [2, "push"] } },
        len: { opcode: "data_lengthoflist", fields: { LIST: ["li", "l1"] } },
        push: { opcode: "data_addtolist", fields: { LIST: ["li", "l1"] }, inputs: { ITEM: [1, [10, "x"]] } },
    }, "rep", {}, { l1: ["li", []] }));
    expectChecks(knip);
    assert.match(knip, /repeat \(li\.length\(\)\) \{/);
    assert.ok(opcodes(build(knip)).has("control_repeat"));
});

test("a for each counts with its own variable, unless the loop would shadow it", () => {
    const loop = (field: [string, string]) => ({
        loop: { opcode: "control_for_each", fields: { VARIABLE: field }, inputs: { VALUE: [1, [6, "3"]], SUBSTACK: [2, "move"] } },
        move: { opcode: "motion_movesteps", parent: "loop", inputs: { STEPS: [1, [4, "1"]] } },
    });
    const inScript = decompileProject(project({
        hat: { opcode: "event_whenflagclicked", next: "loop", topLevel: true, x: 0, y: 0 },
        ...loop(["v", "v1"]),
    }, { v1: ["v", 0] }));
    expectChecks(inScript);
    assert.match(inScript, /for \(v, 3\) \{\n\s+motion\.forward\(1\);/);

    const inProc = decompileProject(procProject(loop(["v", "v1"]), "loop", { v1: ["v", 0] }));
    expectChecks(inProc);
    assert.match(inProc, /for \(i, 3\) \{\n\s+v = i;/);

    const global = project({ hat: { opcode: "event_whenflagclicked", next: "loop", topLevel: true, x: 0, y: 0 }, ...loop(["g", "g1"]) });
    global.targets[0]!.variables = { g1: ["g", 0] };
    const knip = decompileProject(global);
    expectChecks(knip);
    assert.match(knip, /for \(i, 3\) \{\n\s+g = i;/);
});

test("rejects bytes without a project.json", () => {
    assert.throws(() => decompileSb3(new Uint8Array([80, 75, 5, 6, ...new Array(18).fill(0)])), /project\.json/);
});
