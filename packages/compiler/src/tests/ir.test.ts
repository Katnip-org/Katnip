import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, expectClean } from "./helpers.js";
import { IRGenerator } from "../ir/IRGenerator.js";
import type { IRExpr, IRProc, IRProgram, IRStmt } from "../ir/IRNode.js";

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
                onflag() { private y = addone(2); }
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
    assert(program.sprites[0].lists.has("f_stack"), "vlist was not registered on the sprite");

    // Both returns (0 and f(n-1)) push onto the stack; none write a ret var.
    assert.equal(countOpcode(p.body, "data_addtolist"), 2);
    assert.deepEqual(p.retVars, []);
});

test("compound assignment desugars to setvariableto over the binop", () => {
    const program = lower(HAT + `sprite Cat { onflag() { private x = 0; x += 5; } }`);
    const sets = raws(program.sprites[0].scripts[0].body, "data_setvariableto");
    assert.equal(sets.length, 2); // private x = 0, then x = x + 5

    const compound = sets[1];
    assert.deepEqual(compound.inputs[0], { kind: "var", name: "x" });
    assert.deepEqual(compound.inputs[1], {
        kind: "op",
        opcode: "operator_add",
        inputs: [{ kind: "var", name: "x" }, { kind: "lit", value: 5 }],
    });
});

test("a compound assign with no opcode falls back like the binary expression does", () => {
    const program = lower(HAT + `sprite Cat { onflag() { private x = 0; x **= 6; } }`);
    const sets = raws(program.sprites[0].scripts[0].body, "data_setvariableto");
    assert.deepEqual(sets[1].inputs[1], { kind: "lit", value: "" }); // ** has no lowering yet
});

test("command in statement position emits a raw block (no plan lookup crash)", () => {
    const program = lower(HAT + `sprite Cat { onflag() { console.log("hi"); } }`, { stdlib: true });
    const say = program.sprites[0].scripts[0].body.find(
        (s): s is Raw => s.kind === "raw" && s.opcode === "katnip_console_log",
    );
    assert(say, "expected console.log to lower to a raw command block");
    assert.deepEqual(say.inputs, [{ kind: "lit", value: "hi" }]);
});

/** The IRExpr assigned to `x` by `private x = <expr>;` in a flag script. */
function exprOf(source: string) {
    const program = lower(HAT + `sprite Cat { onflag() { private x = ${source}; } }`, { stdlib: true });
    const set = raws(program.sprites[0].scripts[0].body, "data_setvariableto")[0];
    assert(set, "expected a setvariableto for x");
    return set.inputs[1];
}

const A = { kind: "var", name: "a" };
const B = { kind: "var", name: "b" };
const not = (inner: unknown) => ({ kind: "op", opcode: "operator_not", inputs: [inner] });
const op = (opcode: string) => ({ kind: "op", opcode, inputs: [A, B] });

test("operators with no Scratch block inline their builds proc", () => {
    const declare = `private a = true; private b = false; `;
    const of = (src: string) => {
        const program = lower(HAT + `sprite Cat { onflag() { ${declare} private x = ${src}; } }`, {
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
    const program = lower(HAT + `sprite Cat { onflag() { private x = lte(1, 2); } }`, { stdlib: true });
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

test("a builds body containing a call inlines that call too, folding its enum argument", () => {
    const program = lower(HAT + `sprite Cat { onflag() { private x = math.ceil(1.5); } }`, { stdlib: true });
    const body = program.sprites[0].scripts[0].body;
    assert.equal(body.filter((s) => s.kind === "call").length, 0, "builds procs must not emit calls");
    assert.deepEqual(raws(body, "data_setvariableto")[0].inputs[1], {
        kind: "op",
        opcode: "operator_mathop",
        // "ceiling", not "ceil": the enum value is the sb3 OPERATOR field verbatim
        inputs: [{ kind: "lit", value: "ceiling" }, { kind: "lit", value: 1.5 }],
    });
});

test("a cast emits nothing: the operand reaches the use site untouched", () => {
    const program = lower(HAT + `sprite Cat { onflag() { private x: num = Num(1 + 2); } }`, { stdlib: true });
    const body = program.sprites[0].scripts[0].body;
    assert.deepEqual(raws(body, "data_setvariableto")[0].inputs[1], {
        kind: "op",
        opcode: "operator_add",
        inputs: [{ kind: "lit", value: 1 }, { kind: "lit", value: 2 }],
    });
});

test("builds procs get no return plan and emit no proc of their own", () => {
    const program = lower(HAT + `sprite Cat { onflag() { private x = 1 <= 2; } }`, { stdlib: true });
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

test("chained left-associative operators fold left: a - b - c is (a - b) - c", () => {
    // regression: BindingPowerTable previously set rbp = lbp - 1 for left-assoc
    // ops, which let the right-operand parse swallow the next same-precedence
    // operator too, lowering `a - b - c` as `a - (b - c)` instead.
    assert.deepEqual(exprOf("1 - 2 - 3"), {
        kind: "op",
        opcode: "operator_subtract",
        inputs: [
            { kind: "op", opcode: "operator_subtract", inputs: [{ kind: "lit", value: 1 }, { kind: "lit", value: 2 }] },
            { kind: "lit", value: 3 },
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
                onflag() { private y = f(3) + f(f(2)); }
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
    // Named for the staging, not the ABI: `retVars` is empty on a vstack proc.
    assert.deepEqual(p.temps, ["f_staged0"]);
    assert.deepEqual(p.retVars, []);

    const tail = p.body.slice(-4).map((s) => (s.kind === "raw" ? s.opcode : s.kind));
    assert.deepEqual(tail, ["data_setvariableto", "data_deleteoflist", "data_addtolist", "control_stop"]);
});

test("a vstack return with nothing pending pushes inline, with no staging temp", () => {
    // The trigger is pending stack slots, not the return strategy: this proc is
    // recursive (so vstack) but neither return evaluates a call.
    const p = procOf(
        lower(`sprite Cat { proc f(n: num) -> num { if (n < 1) { return 0; } f(n - 1); return n * 10; } }`),
        "Cat",
        "f",
    );
    assert.deepEqual(p.temps, []);
    assert.equal(raws(p.body, "data_setvariableto").length, 0);
});

test("bare return still stops the script", () => {
    const p = procOf(lower(`sprite Cat { proc f(x: num) -> void { if (x < 1) { return; } } }`), "Cat", "f");
    assert.equal(countOpcode(p.body, "control_stop"), 1);
});

test("params read as argument reporters, locals as mangled globals", () => {
    const p = procOf(lower(`sprite Cat { proc f(x: num) -> void { private y = x; } }`), "Cat", "f");
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

test("forever lowers to a forever loop", () => {
    const program = lower(HAT + `sprite Cat { onflag() { private t = 0; forever { t += 1; } } }`);
    const body = program.sprites[0].scripts[0].body;
    assert.deepEqual(body.map((s) => (s.kind === "raw" ? s.opcode : s.kind)), ["data_setvariableto", "forever"]);
});

test("do-while runs its body once before the loop", () => {
    const program = lower(HAT + `sprite Cat { onflag() { private t = 0; do { t += 1; } while (t < 3); } }`);
    const body = program.sprites[0].scripts[0].body;
    assert.deepEqual(
        body.map((s) => (s.kind === "raw" ? s.opcode : s.kind)),
        ["data_setvariableto", "data_setvariableto", "while"],
    );
});

test("for over a list indexes it; for over a num counts directly", () => {
    const program = lower(
        HAT + `sprite Cat { onflag() { private l = [1, 2]; private t = 0; for (v, l) { t += v; } for (i, 5) { t += i; } } }`,
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
    // range(4, 10, 2) => 4, 6, 8, 10: floor((10-4)/2)+1 iterations, remapping the loop var in place
    assert.equal(loop.iter, "x");
    assert.deepEqual(loop.times, { kind: "lit", value: 4 });
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
    assert.deepEqual(loop.times, { kind: "lit", value: 9 });
    assert.deepEqual(loop.body, [{ kind: "raw", opcode: "looks_say", inputs: [{ kind: "lit", value: "a" }] }]);
});

/** Evaluates the counter remap a literal range header emitted, giving the values the loop really yields. */
function rangeValues(args: string): number[] {
    const program = lower(HAT + `sprite Cat { onflag() { for (x, range(${args})) { looks.say("a"); } } }`, {
        stdlib: true,
    });
    const loop = program.sprites[0].scripts[0].body.find((s) => s.kind === "for");
    assert(loop?.kind === "for");
    assert(loop.times.kind === "lit", "a fully literal range must fold to a literal count");

    const first = loop.body[0];
    const remap: IRExpr =
        first?.kind === "raw" && first.opcode === "data_setvariableto"
            ? first.inputs[1]!
            : { kind: "var", name: "x" }; // no remap block => the counter is the value
    const value = (expr: IRExpr, counter: number): number => {
        if (expr.kind === "lit") return Number(expr.value);
        if (expr.kind === "var") return counter;
        assert(expr.kind === "op", `unexpected ${expr.kind} in a range remap`);
        const [left, right] = expr.inputs.map((input) => value(input, counter));
        if (expr.opcode === "operator_add") return left! + right!;
        assert.equal(expr.opcode, "operator_multiply");
        return left! * right!;
    };
    return Array.from({ length: Number(loop.times.value) }, (_, i) => value(remap, i + 1));
}

test("range is 1-based and stop-inclusive, matching Scratch's own counter", () => {
    assert.deepEqual(rangeValues("5"), [1, 2, 3, 4, 5]);
    assert.deepEqual(rangeValues("2, 6"), [2, 3, 4, 5, 6]);
    assert.deepEqual(rangeValues("4, 10, 2"), [4, 6, 8, 10]);
    assert.deepEqual(rangeValues("5, 1, -1"), [5, 4, 3, 2, 1]);
    assert.deepEqual(rangeValues("0"), [], "an empty range runs zero times, not backwards");
});

const PAIRS = `sprite Cat {
    private names: list<str> = ["a", "b"];
    private powers: list<num> = [1, 2];
    onflag() { BODY }
}`;

/** The single for loop a zip()/enumerate() header lowers to. */
function pairLoop(body: string): Extract<IRStmt, { kind: "for" }> {
    const program = lower(HAT + PAIRS.replace("BODY", body), { stdlib: true });
    const loop = program.sprites[0].scripts[0].body.find((s) => s.kind === "for");
    assert(loop?.kind === "for", "zip/enumerate must lower to a counted for, never be dropped");
    return loop;
}

test("for over enumerate() reuses the counter as the index", () => {
    const loop = pairLoop(`for ((i, v), enumerate(names)) { looks.say(v); }`);
    // The 1-based counter already is the index, so only the value costs a block.
    assert.equal(loop.iter, "i");
    assert.deepEqual(loop.times, {
        kind: "op",
        opcode: "data_lengthoflist",
        inputs: [{ kind: "var", name: "names" }],
    });
    assert.deepEqual(loop.body, [
        {
            kind: "raw",
            opcode: "data_setvariableto",
            inputs: [
                { kind: "var", name: "v" },
                {
                    kind: "op",
                    opcode: "data_itemoflist",
                    inputs: [{ kind: "var", name: "names" }, { kind: "var", name: "i" }],
                },
            ],
        },
        { kind: "raw", opcode: "looks_say", inputs: [{ kind: "var", name: "v" }] },
    ]);
});

test("for over zip() walks both lists by the first one's length, reading the index before it is clobbered", () => {
    const loop = pairLoop(`for ((flower, thing), zip(names, powers)) { looks.say(flower); }`);
    assert.equal(loop.iter, "flower");

    // The first list sets the count; a shorter second one reads empty past its end, as Scratch does.
    assert.deepEqual(loop.times, {
        kind: "op",
        opcode: "data_lengthoflist",
        inputs: [{ kind: "var", name: "names" }],
    });

    const item = (list: string) => ({
        kind: "op",
        opcode: "data_itemoflist",
        inputs: [{ kind: "var", name: list }, { kind: "var", name: "flower" }],
    });
    assert.deepEqual(loop.body.slice(0, 2), [
        { kind: "raw", opcode: "data_setvariableto", inputs: [{ kind: "var", name: "thing" }, item("powers")] },
        { kind: "raw", opcode: "data_setvariableto", inputs: [{ kind: "var", name: "flower" }, item("names")] },
    ]);
});

test("one loop variable over a pair binds the first column", () => {
    assert.deepEqual(pairLoop(`for (v, zip(names, powers)) { looks.say(v); }`).body[0], {
        kind: "raw",
        opcode: "data_setvariableto",
        inputs: [
            { kind: "var", name: "v" },
            {
                kind: "op",
                opcode: "data_itemoflist",
                inputs: [{ kind: "var", name: "names" }, { kind: "var", name: "v" }],
            },
        ],
    });
    // enumerate's first column is the counter, so the body is the user's block and nothing else.
    assert.deepEqual(pairLoop(`for (i, enumerate(names)) { looks.say("a"); }`).body, [
        { kind: "raw", opcode: "looks_say", inputs: [{ kind: "lit", value: "a" }] },
    ]);
});

test("switch lowers to an if chain, with default as the final else", () => {
    const program = lower(
        HAT + `sprite Cat { onflag() { private t = 0; switch (t) { case (1, 2) { t = 9; } default { t = 8; } } } }`,
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

test("list and dict declarations become lists; scalars stay variables", () => {
    const program = lower(
        `private highScores: list<num> = [10, 20, 30];
         private settings: dict<str, num> = {"volume": 100};
         private level: num = 1;
         sprite Cat {
             private inventory = ["fish"];
             private empty: list<str>;
         }`,
    );

    assert.deepEqual(program.variables, new Map([["level", 1]]), "a constant initializer must be baked in");
    assert.deepEqual(program.lists.get("highScores"), [10, 20, 30]);
    assert(!program.lists.has("settings"), "a dict must not become a single list");
    assert.deepEqual(program.lists.get("settings_keys"), ["volume"]);
    assert.deepEqual(program.lists.get("settings_vals"), [100]);

    const cat = program.sprites[0];
    assert.deepEqual(cat.variables, new Map());
    assert.deepEqual(cat.lists.get("inventory"), ["fish"], "the type must be inferred without an annotation");
    assert.deepEqual(cat.lists.get("empty"), []);
});

test("the access modifier picks the owner, not the position", () => {
    const program = lower(
        HAT + `sprite Cat {
                   public score: num = 0;
                   private lives: num = 9;
                   public roster: list<num> = [1, 2];
                   private paws: list<num> = [4];
                   onflag() { public total: num = 0; private mine: num = 1; }
               }`,
    );
    const cat = program.sprites[0];

    // `public` is Scratch's "for all sprites" -- it lands on the stage wherever it is written.
    assert.deepEqual([...program.variables.keys()], ["score", "total"]);
    assert.deepEqual(program.lists.get("roster"), [1, 2]);
    assert.deepEqual([...cat.variables.keys()], ["lives", "mine"]);
    assert.deepEqual(cat.lists.get("paws"), [4]);
});

test("a public member keeps its name; only a sprite-owned collision is renamed", () => {
    const program = lower(
        `public greeting: str = "Katnip";
         sprite Cat { private greeting: str = "Cat"; }
         sprite Dog { public greeting2: str = "Dog"; }`,
    );
    assert.deepEqual(
        [...program.sprites[0].variables.keys()],
        ["Cat_greeting"],
        "a sprite-owned name must clear the stage's",
    );
    assert.deepEqual(program.sprites[1].variables, new Map());
    assert.deepEqual([...program.variables.keys()], ["greeting", "greeting2"]);
});

test("a declaration inside a script hoists the storage and initializes it in place", () => {
    const program = lower(HAT + `sprite Cat { onflag() { private thing = [5, 2]; private n = 7; } }`);
    const cat = program.sprites[0];

    // Scratch has no scoped storage, so the list exists at sprite level -- but empty, because the
    // declaration is a statement: it must refill on every run, not be baked into the project file.
    assert.deepEqual(cat.lists.get("thing"), []);
    assert.deepEqual([...cat.variables.keys()], ["n"]);
    assert.equal(cat.scripts.length, 1, "the initializer belongs in the script, not a green-flag prologue");

    const thing: IRExpr = { kind: "var", name: "thing" };
    assert.deepEqual(cat.scripts[0].body, [
        { kind: "raw", opcode: "data_deletealloflist", inputs: [thing] },
        { kind: "raw", opcode: "data_addtolist", inputs: [thing, { kind: "lit", value: 5 }] },
        { kind: "raw", opcode: "data_addtolist", inputs: [thing, { kind: "lit", value: 2 }] },
        { kind: "raw", opcode: "data_setvariableto", inputs: [{ kind: "var", name: "n" }, { kind: "lit", value: 7 }] },
    ]);
});

test("a non-literal initializer is built by a green-flag script ahead of the user's own", () => {
    const program = lower(
        `private seed: num = 7;
         private xs: list<num> = [1, seed];
         private d: dict<str, num> = {"a": seed};
         sprite Cat { events.onFlag() { looks.say("go"); } }`,
        { stdlib: true },
    );

    // Nothing can be baked: a half-baked dict would desync its columns on the next green flag.
    assert.deepEqual(program.lists.get("xs"), []);
    assert.deepEqual(program.lists.get("d_keys"), []);
    assert.deepEqual(program.lists.get("d_vals"), []);

    const [init, user] = program.sprites[0].scripts;
    assert.equal(init.hatOpcode, "event_whenflagclicked", "init must be a green-flag script");
    assert.equal(raws(user.body, "looks_say").length, 1, "the user's own handler must come after it");

    assert.deepEqual(
        init.body.map((s) => (s.kind === "raw" ? s.opcode : s.kind)),
        [
            "data_deletealloflist", "data_addtolist", "data_addtolist",
            "data_deletealloflist", "data_addtolist",
            "data_deletealloflist", "data_addtolist",
        ],
    );
    const adds = raws(init.body, "data_addtolist");
    assert.deepEqual(adds[0].inputs, [{ kind: "var", name: "xs" }, { kind: "lit", value: 1 }]);
    assert.deepEqual(adds[1].inputs, [{ kind: "var", name: "xs" }, { kind: "var", name: "seed" }]);
    assert.deepEqual(adds[2].inputs, [{ kind: "var", name: "d_keys" }, { kind: "lit", value: "a" }]);
    assert.deepEqual(adds[3].inputs, [{ kind: "var", name: "d_vals" }, { kind: "var", name: "seed" }]);
});

/** The IRExpr assigned to `t` by `private t = <expr>;`, with a list, a dict and a str in scope. */
function indexed(source: string) {
    const program = lower(
        `private xs: list<num> = [1, 2];
         private d: dict<str, num> = {"a": 1};
         private s: str = "abc";
         sprite Cat { events.onFlag() { private t = ${source}; } }`,
        { stdlib: true },
    );
    return raws(program.sprites[0].scripts[0].body, "data_setvariableto")[0].inputs[1];
}

test("indexed reads: a list indexes directly, a dict goes through its keys column, a str is letter-of", () => {
    assert.deepEqual(indexed("xs[2]"), {
        kind: "op",
        opcode: "data_itemoflist",
        inputs: [{ kind: "var", name: "xs" }, { kind: "lit", value: 2 }],
    });
    assert.deepEqual(indexed(`d["a"]`), {
        kind: "op",
        opcode: "data_itemoflist",
        inputs: [
            { kind: "var", name: "d_vals" },
            {
                kind: "op",
                opcode: "data_itemnumoflist",
                inputs: [{ kind: "var", name: "d_keys" }, { kind: "lit", value: "a" }],
            },
        ],
    });
    assert.deepEqual(indexed("s[1]"), {
        kind: "op",
        opcode: "operator_letter_of",
        inputs: [{ kind: "lit", value: 1 }, { kind: "var", name: "s" }],
    });
});

/** The statements `body` lowers to in a flag script, with a list and a dict in scope. */
function stmts(body: string): IRStmt[] {
    const program = lower(
        `private xs: list<num> = [1, 2];
         private d: dict<str, num> = {"a": 1};
         sprite Cat { events.onFlag() { ${body} } }`,
        { stdlib: true },
    );
    return program.sprites[0].scripts[0].body;
}

test("a list write replaces in place, and a compound one reads the slot back", () => {
    assert.deepEqual(stmts("xs[2] = 9;"), [
        {
            kind: "raw",
            opcode: "data_replaceitemoflist",
            inputs: [{ kind: "var", name: "xs" }, { kind: "lit", value: 2 }, { kind: "lit", value: 9 }],
        },
    ]);
    assert.deepEqual(raws(stmts("xs[2] += 1;"), "data_replaceitemoflist")[0].inputs[2], {
        kind: "op",
        opcode: "operator_add",
        inputs: [
            {
                kind: "op",
                opcode: "data_itemoflist",
                inputs: [{ kind: "var", name: "xs" }, { kind: "lit", value: 2 }],
            },
            { kind: "lit", value: 1 },
        ],
    });
});

test("a dict write replaces a present key and appends to both columns otherwise", () => {
    const [write] = stmts(`d["b"] = 5;`);
    assert(write.kind === "if");

    const at = {
        kind: "op",
        opcode: "data_itemnumoflist",
        inputs: [{ kind: "var", name: "d_keys" }, { kind: "lit", value: "b" }],
    };
    assert.deepEqual(write.cond, { kind: "op", opcode: "operator_gt", inputs: [at, { kind: "lit", value: 0 }] });
    assert.deepEqual(write.then, [
        {
            kind: "raw",
            opcode: "data_replaceitemoflist",
            inputs: [{ kind: "var", name: "d_vals" }, at, { kind: "lit", value: 5 }],
        },
    ]);
    assert.deepEqual(write.else, [
        {
            kind: "raw",
            opcode: "data_addtolist",
            inputs: [{ kind: "var", name: "d_keys" }, { kind: "lit", value: "b" }],
        },
        {
            kind: "raw",
            opcode: "data_addtolist",
            inputs: [{ kind: "var", name: "d_vals" }, { kind: "lit", value: 5 }],
        },
    ]);
});

test("dict iteration walks the keys column, binding the value before the key overwrites the counter", () => {
    const [loop] = stmts(`for ((k, v), d) { looks.say(k); }`);
    assert(loop.kind === "for");
    assert.equal(loop.iter, "k");
    assert.deepEqual(loop.times, {
        kind: "op",
        opcode: "data_lengthoflist",
        inputs: [{ kind: "var", name: "d_keys" }],
    });
    assert.deepEqual(loop.body.slice(0, 2), [
        {
            kind: "raw",
            opcode: "data_setvariableto",
            inputs: [
                { kind: "var", name: "v" },
                {
                    kind: "op",
                    opcode: "data_itemoflist",
                    inputs: [{ kind: "var", name: "d_vals" }, { kind: "var", name: "k" }],
                },
            ],
        },
        {
            kind: "raw",
            opcode: "data_setvariableto",
            inputs: [
                { kind: "var", name: "k" },
                {
                    kind: "op",
                    opcode: "data_itemoflist",
                    inputs: [{ kind: "var", name: "d_keys" }, { kind: "var", name: "k" }],
                },
            ],
        },
    ]);

    // Without a tuple pattern there is nowhere to put the value, so only the key is bound.
    const [single] = stmts(`for (k, d) { }`);
    assert(single.kind === "for");
    assert.equal(single.body.length, 1);
});

test("indexing anything but a declared list or dict fails loudly", () => {
    assert.throws(
        () => stmts(`private t = range(3)[1];`),
        /only a declared list or dict can be indexed/,
    );
});

// -- constant member expressions --

/** The value a single `private c = <expr>;` script assigns. */
function folded(decls: string, expr: string): IRExpr {
    const program = lower(`${decls}sprite Cat { events.onFlag() { private c = ${expr}; } }`, {
        stdlib: true,
    });
    const [set] = raws(program.sprites[0].scripts[0].body, "data_setvariableto");
    return set.inputs[1];
}

test("a user enum member folds to its qualified name, keeping explicit values", () => {
    const decls = `enum Color { red, green }\nenum Paint { red = "R" }\n`;
    // Implicit values qualify, so two enums sharing a member name never compare equal.
    assert.deepEqual(folded(decls, "Color.red"), { kind: "lit", value: "Color.red" });
    assert.deepEqual(folded(decls, "Paint.red"), { kind: "lit", value: "R" });
});

test("a namespace constant folds to its literal", () => {
    assert.deepEqual(folded("", "math.pi"), { kind: "lit", value: 3.141592653589793 });
});

test("a stdlib enum keeps the bare value sb3 fields match on", () => {
    // looks.costume()'s omitted `mode` defaults to NumberName.NUMBER, which sb3 reads as "number".
    const value = folded("", "looks.costume()");
    assert.equal(value.kind, "op");
    assert.deepEqual(value.inputs[0], { kind: "lit", value: "number" });
});

test("an unresolved member expression stays empty rather than throwing", () => {
    assert.deepEqual(folded("", "self.whatever"), { kind: "lit", value: "" });
});

// -- call arguments --

test("a method call fills `self` from the receiver, not the first argument", () => {
    const [add] = stmts(`xs.add(7);`);
    assert.deepEqual(add, {
        kind: "raw",
        opcode: "data_addtolist",
        inputs: [{ kind: "var", name: "xs" }, { kind: "lit", value: 7 }],
    });
});

test("named arguments route by name, not by position", () => {
    const [goto] = stmts(`motion.goTo(y = 5, x = 1);`);
    assert(goto.kind === "raw");
    assert.equal(goto.opcode, "motion_gotoxy");
    assert.deepEqual(goto.inputs, [{ kind: "lit", value: 1 }, { kind: "lit", value: 5 }]);
});
