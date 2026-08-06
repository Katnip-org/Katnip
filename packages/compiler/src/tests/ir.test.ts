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
    assert.deepEqual(p.retVars, []);
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

test("interpolated strings lower to right-nested joins", () => {
    const join = (a: unknown, b: unknown) => ({ kind: "op", opcode: "operator_join", inputs: [a, b] });
    assert.deepEqual(exprOf(`f"a{1}b"`), join({ kind: "lit", value: "a" }, join({ kind: "lit", value: 1 }, { kind: "lit", value: "b" })));
    assert.deepEqual(exprOf(`f"{1}"`), { kind: "lit", value: 1 });
});

test("vstack call sites read by depth from the top and pop what they pushed", () => {
    const program = lower(
        HAT +
            `sprite Cat {
                proc f(n: num) -> num { if (n < 1) { return 0; } return f(n - 1); }
                onflag() { temp y = f(3) + f(f(2)); }
            }`,
    );
    const body = program.sprites[0].scripts[0].body;
    assert.equal(body.filter((s) => s.kind === "call").length, 3);

    // the inner f(2) result is on top when f(f(2)) runs, so its ref is depth 0
    const nested = body.filter((s) => s.kind === "call")[2];
    assert(nested.kind === "call");
    assert.deepEqual(nested.args, [{ kind: "stackref", list: "f_stack", depth: 0 }]);

    const sum = raws(body, "data_setvariableto")[0];
    assert.deepEqual(sum.inputs[1], {
        kind: "op",
        opcode: "operator_add",
        inputs: [
            { kind: "stackref", list: "f_stack", depth: 2 },
            { kind: "stackref", list: "f_stack", depth: 0 },
        ],
    });
    assert.equal(raws(body, "data_deleteoflist").length, 3, "every pushed slot must be popped");
});

test("a vstack return stages its value so the pops cannot eat it", () => {
    const p = procOf(
        lower(`sprite Cat { proc f(n: num) -> num { if (n < 1) { return 0; } return f(n - 1) + 1; } }`),
        "Cat",
        "f",
    );
    assert.deepEqual(p.temps, ["f_ret0"]);

    const tail = p.body.slice(-4).map((s) => (s.kind === "raw" ? s.opcode : s.kind));
    assert.deepEqual(tail, ["data_setvariableto", "data_deleteoflist", "data_addtolist", "control_stop"]);
});

test("bare return still stops the script", () => {
    const p = procOf(lower(`sprite Cat { proc f(x: num) -> void { if (x < 1) { return; } } }`), "Cat", "f");
    assert.equal(countOpcode(p.body, "control_stop"), 1);
});

test("params read as argument reporters, locals as mangled globals", () => {
    const p = procOf(lower(`sprite Cat { proc f(x: num) -> void { temp y = x; } }`), "Cat", "f");
    assert.deepEqual(p.temps, ["f_y"]);
    assert.deepEqual(raws(p.body, "data_setvariableto")[0].inputs, [
        { kind: "var", name: "f_y" },
        { kind: "param", name: "x" },
    ]);
});

test("+ over str operands is operator_join, not operator_add", () => {
    assert.deepEqual(exprOf(`"a" + "b"`), {
        kind: "op",
        opcode: "operator_join",
        inputs: [{ kind: "lit", value: "a" }, { kind: "lit", value: "b" }],
    });
    const num = exprOf("1 + 2");
    assert.equal(num.kind === "op" && num.opcode, "operator_add");
});

test("do-while runs its body once before the loop", () => {
    const program = lower(HAT + `sprite Cat { onflag() { temp t = 0; do { t += 1; } while (t < 3); } }`);
    const body = program.sprites[0].scripts[0].body;
    assert.deepEqual(
        body.map((s) => (s.kind === "raw" ? s.opcode : s.kind)),
        ["data_setvariableto", "data_setvariableto", "while"],
    );
});

test("for over a list indexes it; for over a num counts directly", () => {
    const program = lower(
        HAT + `sprite Cat { onflag() { temp l = [1, 2]; temp t = 0; for (v, l) { t += v; } for (i, 5) { t += i; } } }`,
    );
    const loops = program.sprites[0].scripts[0].body.filter((s) => s.kind === "for");
    assert.equal(loops.length, 2);

    assert(loops[0].kind === "for");
    assert.equal(loops[0].iter, "v", "the loop var is its own index");
    assert.deepEqual(loops[0].times, { kind: "op", opcode: "data_lengthoflist", inputs: [{ kind: "var", name: "l" }] });
    assert.deepEqual(loops[0].body[0], {
        kind: "raw",
        opcode: "data_setvariableto",
        inputs: [
            { kind: "var", name: "v" },
            { kind: "op", opcode: "data_itemoflist", inputs: [{ kind: "var", name: "l" }, { kind: "var", name: "v" }] },
        ],
    });

    assert(loops[1].kind === "for");
    assert.equal(loops[1].iter, "i");
    assert.deepEqual(loops[1].times, { kind: "lit", value: 5 });
});

test("for over range() counts instead of building a list", () => {
    const program = lower(
        HAT + `sprite Cat { onflag() { for (x, range(4, 10, 2)) { looks.say("a"); } } }`,
        { stdlib: true },
    );
    const loop = program.sprites[0].scripts[0].body.find((s) => s.kind === "for");
    assert(loop?.kind === "for", "range must lower to a counted for, not a list walk");
    // range(4, 10, 2) => 4, 6, 8: ceil((10-4)/2) iterations, remapping the loop var in place
    assert.equal(loop.iter, "x");
    assert.deepEqual(loop.times, { kind: "lit", value: 3 });
    assert.deepEqual(loop.body[0], {
        kind: "raw",
        opcode: "data_setvariableto",
        inputs: [
            { kind: "var", name: "x" },
            {
                kind: "op",
                opcode: "operator_add",
                inputs: [
                    { kind: "op", opcode: "operator_multiply", inputs: [{ kind: "var", name: "x" }, { kind: "lit", value: 2 }] },
                    { kind: "lit", value: 2 },
                ],
            },
        ],
    });
});

test("range(1, n) needs no remap block at all", () => {
    const program = lower(HAT + `sprite Cat { onflag() { for (x, range(1, 9)) { looks.say("a"); } } }`, {
        stdlib: true,
    });
    const loop = program.sprites[0].scripts[0].body.find((s) => s.kind === "for");
    assert(loop?.kind === "for");
    assert.equal(loop.iter, "x");
    assert.deepEqual(loop.times, { kind: "lit", value: 8 });
    assert.deepEqual(loop.body, [{ kind: "raw", opcode: "looks_say", inputs: [{ kind: "lit", value: "a" }] }]);
});

test("switch lowers to an if chain, with default as the final else", () => {
    const program = lower(
        HAT + `sprite Cat { onflag() { temp t = 0; switch (t) { case (1, 2) { t = 9; } default { t = 8; } } } }`,
    );
    const chain = program.sprites[0].scripts[0].body.find((s) => s.kind === "if");
    assert(chain?.kind === "if");
    assert.deepEqual(chain.cond, {
        kind: "op",
        opcode: "operator_or",
        inputs: [
            { kind: "op", opcode: "operator_equals", inputs: [{ kind: "var", name: "t" }, { kind: "lit", value: 1 }] },
            { kind: "op", opcode: "operator_equals", inputs: [{ kind: "var", name: "t" }, { kind: "lit", value: 2 }] },
        ],
    });
    assert.equal(raws(chain.else, "data_setvariableto").length, 1, "default must be the trailing else");
});
