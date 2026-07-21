import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, expectClean } from "./helpers.js";
import { IRGenerator } from "../ir/IRGenerator.js";
import type { IRProc, IRProgram, IRStmt } from "../ir/IRNode.js";

type Raw = Extract<IRStmt, { kind: "raw" }>;

function lower(source: string, opts?: { stdlib?: boolean }): IRProgram {
    const result = compile(source, opts);
    expectClean(result);
    return new IRGenerator(result.analyzer).generate(result.ast);
}

function procOf(program: IRProgram, sprite: string, name: string): IRProc {
    const s = program.sprites.find((s) => s.name === sprite);
    assert(s, `sprite ${sprite} not found`);
    const p = s.procs.get(name);
    assert(p, `proc ${name} not found`);
    return p;
}

/** Raw blocks with the given opcode at the top level of `body`. */
function raws(body: IRStmt[], opcode: string): Raw[] {
    return body.filter((s): s is Raw => s.kind === "raw" && s.opcode === opcode);
}

/** Count raw blocks with `opcode` anywhere in `body`, descending into control substacks. */
function countOpcode(body: IRStmt[], opcode: string): number {
    let n = 0;
    for (const s of body) {
        if (s.kind === "raw" && s.opcode === opcode) n++;
        else if (s.kind === "if") n += countOpcode(s.then, opcode) + countOpcode(s.else, opcode);
        else if (s.kind === "while" || s.kind === "forever" || s.kind === "repeat" || s.kind === "for")
            n += countOpcode(s.body, opcode);
    }
    return n;
}

const HAT = `proc onflag(@opcode = "event_whenflagclicked", @hat) -> void {}\n`;

// User procs don't round-trip yet: return plans come from procSignatures (top-level procs only),
// but lowering only emits sprite-inner procs. Neither set overlaps. Unskip once both sides agree.
const NO_PROC_ROUNDTRIP = { skip: "blocked: procSignatures is top-level only, lowering is sprite-only" };

test("scalar var proc: return writes the ret var, then stops the script", NO_PROC_ROUNDTRIP, () => {
    const p = procOf(lower(`sprite Cat { proc addone(x: num) -> num { return x + 1; } }`), "Cat", "addone");
    assert.equal(p.strategy, "var");
    assert.equal(p.returns.kind, "scalar");
    assert.deepEqual(p.retVars, ["addone_ret"]);

    const sets = raws(p.body, "data_setvariableto");
    assert.equal(sets.length, 1);
    assert.deepEqual(sets[0].inputs[0], { kind: "var", name: "addone_ret" });
    assert.equal(raws(p.body, "control_stop").length, 1);
});

test("scalar var call site: emits a call, then reads the ret var into the target", NO_PROC_ROUNDTRIP, () => {
    const program = lower(
        HAT +
            `sprite Cat {
                proc addone(x: num) -> num { return x + 1; }
                onflag() { temp y = addone(2); }
            }`,
    );
    const script = program.sprites[0].scripts[0];
    assert.equal(script.hatOpcode, "event_whenflagclicked");

    const call = script.body.find((s) => s.kind === "call");
    assert(call?.kind === "call");
    assert.equal(call.proc, "addone");
    assert.deepEqual(call.args, [{ kind: "lit", value: 2 }]);

    const set = script.body.find((s): s is Raw => s.kind === "raw" && s.opcode === "data_setvariableto");
    assert(set, "expected the ret var to be read into y");
    assert.deepEqual(set.inputs[0], { kind: "var", name: "y" });
    assert.deepEqual(set.inputs[1], { kind: "var", name: "addone_ret" });
});

test("tuple var proc: one ret var per element, written in order", NO_PROC_ROUNDTRIP, () => {
    const p = procOf(lower(`sprite Cat { proc pair() -> (num, num) { return (1, 2); } }`), "Cat", "pair");
    assert.equal(p.strategy, "var");
    assert.deepEqual(p.retVars, ["pair_ret0", "pair_ret1"]);

    const sets = raws(p.body, "data_setvariableto");
    assert.equal(sets.length, 2);
    assert.deepEqual(sets[0].inputs[0], { kind: "var", name: "pair_ret0" });
    assert.deepEqual(sets[1].inputs[0], { kind: "var", name: "pair_ret1" });
});

test("vstack proc: registers its stack list and pushes returns onto it", NO_PROC_ROUNDTRIP, () => {
    const program = lower(
        `sprite Cat {
            proc f(n: num) -> num { if (n < 1) { return 0; } return f(n - 1); }
        }`,
    );
    const p = procOf(program, "Cat", "f");
    assert.equal(p.strategy, "vstack");
    assert.equal(p.vlist, "f_stack");
    assert(program.sprites[0].lists.includes("f_stack"), "vlist was not registered on the sprite");

    // Both returns (0 and f(n-1)) push onto the stack; none write a ret var.
    assert.equal(countOpcode(p.body, "data_addtolist"), 2);
    assert.equal(countOpcode(p.body, "data_setvariableto"), 0);
});

test("compound assignment desugars to setvariableto over the binop", () => {
    const program = lower(HAT + `sprite Cat { onflag() { temp x = 0; x += 5; } }`);
    const sets = raws(program.sprites[0].scripts[0].body, "data_setvariableto");
    assert.equal(sets.length, 2); // temp x = 0, then x = x + 5

    const compound = sets[1];
    assert.deepEqual(compound.inputs[0], { kind: "var", name: "x" });
    assert.deepEqual(compound.inputs[1], {
        kind: "op",
        opcode: "operator_add",
        inputs: [{ kind: "var", name: "x" }, { kind: "lit", value: 5 }],
    });
});

test("command in statement position emits a raw block (no plan lookup crash)", () => {
    const program = lower(HAT + `sprite Cat { onflag() { console.log("hi"); } }`, { stdlib: true });
    const say = program.sprites[0].scripts[0].body.find(
        (s): s is Raw => s.kind === "raw" && s.opcode === "katnip_console_log",
    );
    assert(say, "expected console.log to lower to a raw command block");
    assert.deepEqual(say.inputs, [{ kind: "lit", value: "hi" }]);
});
