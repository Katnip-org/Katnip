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

test("scalar var proc: return writes the ret var, then stops the script", () => {
    const p = procOf(lower(`sprite Cat { proc addone(x: num) -> num { return x + 1; } }`), "Cat", "addone");
    assert.equal(p.strategy, "var");
    assert.equal(p.returns.kind, "scalar");
    assert.deepEqual(p.retVars, ["addone_ret"]);

    const sets = raws(p.body, "data_setvariableto");
    assert.equal(sets.length, 1);
    assert.deepEqual(sets[0].inputs[0], { kind: "var", name: "addone_ret" });
    assert.equal(raws(p.body, "control_stop").length, 1);
});

test("scalar var call site: emits a call, then reads the ret var into the target", () => {
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

test("tuple var proc: one ret var per element, written in order", () => {
    const p = procOf(lower(`sprite Cat { proc pair() -> (num, num) { return (1, 2); } }`), "Cat", "pair");
    assert.equal(p.strategy, "var");
    assert.deepEqual(p.retVars, ["pair_ret0", "pair_ret1"]);

    const sets = raws(p.body, "data_setvariableto");
    assert.equal(sets.length, 2);
    assert.deepEqual(sets[0].inputs[0], { kind: "var", name: "pair_ret0" });
    assert.deepEqual(sets[1].inputs[0], { kind: "var", name: "pair_ret1" });
});

test("vstack proc: registers its stack list and pushes returns onto it", () => {
    const program = lower(
        `sprite Cat {
            proc f(n: num) -> num { if (n < 1) { return 0; } return f(n - 1); }
        }`,
    );
    const p = procOf(program, "Cat", "f");
    assert.equal(p.strategy, "vstack");
    assert.equal(p.vStackName, "f_stack");
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

/** The IRExpr assigned to `x` by `temp x = <expr>;` in a flag script. */
function exprOf(source: string) {
    const program = lower(HAT + `sprite Cat { onflag() { temp x = ${source}; } }`, { stdlib: true });
    const set = raws(program.sprites[0].scripts[0].body, "data_setvariableto")[0];
    assert(set, "expected a setvariableto for x");
    return set.inputs[1];
}

const A = { kind: "var", name: "a" };
const B = { kind: "var", name: "b" };
const not = (inner: unknown) => ({ kind: "op", opcode: "operator_not", inputs: [inner] });
const op = (opcode: string) => ({ kind: "op", opcode, inputs: [A, B] });

test("operators with no Scratch block inline their builds proc", () => {
    const declare = `temp a = true; temp b = false; `;
    const of = (src: string) => {
        const program = lower(HAT + `sprite Cat { onflag() { ${declare} temp x = ${src}; } }`, {
            stdlib: true,
        });
        return raws(program.sprites[0].scripts[0].body, "data_setvariableto")[2].inputs[1];
    };

    assert.deepEqual(of("a !& b"), not(op("operator_and")));
    assert.deepEqual(of("a !| b"), not(op("operator_or")));
    assert.deepEqual(of("a !^ b"), op("operator_equals"));
    assert.deepEqual(of("a ^ b"), not(op("operator_equals")));
});

test("<= and >= lower to a negated gt/lt", () => {
    assert.deepEqual(exprOf("1 <= 2"), {
        kind: "op",
        opcode: "operator_not",
        inputs: [
            {
                kind: "op",
                opcode: "operator_gt",
                inputs: [{ kind: "lit", value: 1 }, { kind: "lit", value: 2 }],
            },
        ],
    });
    assert.deepEqual(exprOf("1 >= 2"), {
        kind: "op",
        opcode: "operator_not",
        inputs: [
            {
                kind: "op",
                opcode: "operator_lt",
                inputs: [{ kind: "lit", value: 1 }, { kind: "lit", value: 2 }],
            },
        ],
    });
});

test("a builds proc called by name inlines the same way, with no proc call emitted", () => {
    const program = lower(HAT + `sprite Cat { onflag() { temp x = lte(1, 2); } }`, { stdlib: true });
    const body = program.sprites[0].scripts[0].body;
    assert.equal(body.filter((s) => s.kind === "call").length, 0, "builds procs must not emit calls");
    assert.deepEqual(raws(body, "data_setvariableto")[0].inputs[1], {
        kind: "op",
        opcode: "operator_not",
        inputs: [
            {
                kind: "op",
                opcode: "operator_gt",
                inputs: [{ kind: "lit", value: 1 }, { kind: "lit", value: 2 }],
            },
        ],
    });
});

test("builds procs get no return plan and emit no proc of their own", () => {
    const program = lower(HAT + `sprite Cat { onflag() { temp x = 1 <= 2; } }`, { stdlib: true });
    assert.equal(program.procs.size, 0);
    assert.equal(program.sprites[0].procs.size, 0);
});

test("unary ! and - lower to not / 0 - x", () => {
    assert.deepEqual(exprOf("!(1 == 2)"), not({
        kind: "op",
        opcode: "operator_equals",
        inputs: [{ kind: "lit", value: 1 }, { kind: "lit", value: 2 }],
    }));
    assert.deepEqual(exprOf("-(1 + 2)"), {
        kind: "op",
        opcode: "operator_subtract",
        inputs: [
            { kind: "lit", value: 0 },
            { kind: "op", opcode: "operator_add", inputs: [{ kind: "lit", value: 1 }, { kind: "lit", value: 2 }] },
        ],
    });
});
