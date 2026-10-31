/**
 * @fileoverview Runs lowered IR on a tiny evaluator, for features whose correctness is the value they compute
 * (`**`, slices, tuple patterns), and pins the constructs that must refuse to build instead of miscompiling.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { compileToIR, compileToSb3 } from "../index.js";
import type { IRExpr, IRProc, IRProgram, IRStmt } from "../ir/IRNode.js";

class Stop extends Error {}

const mathops: Record<string, (x: number) => number> = {
    abs: Math.abs,
    floor: Math.floor,
    ln: Math.log,
    sqrt: Math.sqrt,
    "e ^": Math.exp,
};

/** Runs the first sprite's scripts in order and returns everything `looks.say` said. */
function run(source: string): unknown[] {
    const { errors, ir } = compileToIR(source);
    assert.ok(ir, errors.map((e) => e.message).join("\n"));
    const program: IRProgram = ir;
    const sprite = program.sprites[0]!;
    const vars = new Map<string, any>([...program.variables, ...sprite.variables]);
    const lists = new Map<string, any[]>([...program.lists, ...sprite.lists].map(([k, v]) => [k, [...v]]));
    const procs = new Map<string, IRProc>([...program.procs.values(), ...sprite.procs.values()].map((p) => [p.name, p]));
    const said: unknown[] = [];
    const listOf = (expr: IRExpr) => lists.get((expr as { name: string }).name)!;

    const value = (expr: IRExpr, args: Map<string, any>): any => {
        switch (expr.kind) {
            case "lit": return expr.value;
            case "var": return vars.get(expr.name);
            case "param": return args.get(expr.name);
            case "stackref": {
                const list = lists.get(expr.list)!;
                return list[list.length - 1 - expr.depth];
            }
        }
        const at = (i: number) => value(expr.inputs[i]!, args);
        const n = (i: number) => Number(at(i));
        switch (expr.opcode) {
            case "operator_add": return n(0) + n(1);
            case "operator_subtract": return n(0) - n(1);
            case "operator_multiply": return n(0) * n(1);
            case "operator_divide": return n(0) / n(1);
            case "operator_mod": return n(0) % n(1);
            case "operator_gt": return n(0) > n(1);
            case "operator_lt": return n(0) < n(1);
            case "operator_equals": return String(at(0)) === String(at(1));
            case "operator_and": return at(0) && at(1);
            case "operator_or": return at(0) || at(1);
            case "operator_not": return !at(0);
            case "operator_join": return `${at(0)}${at(1)}`;
            case "operator_length": return String(at(0)).length;
            case "operator_letter_of": return String(at(1))[n(0) - 1] ?? "";
            case "operator_mathop": return mathops[at(0)]!(n(1));
            case "data_lengthoflist": return listOf(expr.inputs[0]!).length;
            case "data_itemoflist": return listOf(expr.inputs[0]!)[n(1) - 1] ?? "";
        }
        throw new Error(`evaluator has no ${expr.opcode}`);
    };

    const exec = (stmts: IRStmt[], args: Map<string, any>): void => {
        for (const stmt of stmts) {
            switch (stmt.kind) {
                case "call": {
                    const proc = procs.get(stmt.proc)!;
                    const inner = new Map(proc.params.map((p, i) => [p.name, value(stmt.args[i]!, args)]));
                    try {
                        exec(proc.body, inner);
                    } catch (err) {
                        if (!(err instanceof Stop)) throw err;
                    }
                    break;
                }
                case "if":
                    exec(value(stmt.cond, args) ? stmt.then : stmt.else, args);
                    break;
                case "while":
                    while (value(stmt.cond, args)) exec(stmt.body, args);
                    break;
                case "repeat":
                    for (let i = Number(value(stmt.times, args)); i > 0; i--) exec(stmt.body, args);
                    break;
                case "for": {
                    const times = Number(value(stmt.times, args));
                    for (let i = 1; i <= times; i++) {
                        vars.set(stmt.iter, i);
                        exec(stmt.body, args);
                        vars.set(stmt.iter, i);
                    }
                    break;
                }
                case "forever":
                    throw new Error("evaluator cannot run forever");
                case "raw": {
                    const [first, second] = stmt.inputs;
                    switch (stmt.opcode) {
                        case "data_setvariableto":
                            vars.set((first as { name: string }).name, value(second!, args));
                            break;
                        case "data_addtolist":
                            listOf(first!).push(value(second!, args));
                            break;
                        case "data_deletealloflist":
                            listOf(first!).length = 0;
                            break;
                        case "data_deleteoflist":
                            listOf(first!).pop();
                            break;
                        case "looks_say":
                            said.push(value(first!, args));
                            break;
                        case "control_stop":
                            throw new Stop();
                        default:
                            throw new Error(`evaluator has no ${stmt.opcode}`);
                    }
                }
            }
        }
    };
    for (const script of sprite.scripts) exec(script.body, new Map());
    return said;
}

/** What each expression says, one at a time, with `decls` at the top level. */
function says(expr: string, decls = ""): unknown {
    return run(`${decls} sprite Cat { events.onFlag() { looks.say(f"{${expr}}"); } }`)[0];
}

test("** folds literals and computes through inline blocks or math.pow", () => {
    assert.equal(says("2 ** 3"), 8);
    assert.equal(says("2 ** -2"), 0.25);
    assert.equal(says("(0 - 2) ** 3"), -8);
    assert.equal(says("2 ** 3 ** 2"), 512, "right associative");

    const vars = `public b: num = 2; public n: num = 0 - 8; public e: num = 2;`;
    assert.equal(says("b ** 0", vars), 1);
    assert.equal(says("b ** 1", vars), 2);
    assert.equal(says("b ** 2", vars), 4);
    assert.equal(says("b ** 3", vars), 8);
    assert.equal(says("(b + 1) ** 2", vars), 9);
    assert.equal(says("b ** 4", vars), 16);
    assert.equal(says("b ** 40", vars), 2 ** 40);
    assert.equal(says("b ** -2", vars), 0.25);
    assert.equal(says("n ** 3", vars), -512);
    assert.equal(says("b ** e", vars), 4);
    assert.ok(Math.abs((says("b ** 1.5", vars) as number) - Math.SQRT2 * 2) < 1e-9);
    assert.ok(Math.abs((says("b ** 0.5", vars) as number) - Math.SQRT2) < 1e-9);
    assert.ok(Number.isNaN(says("n ** 1.5", vars)), "no real answer");
    assert.ok(Number.isNaN(says("n ** 0.5", vars)), "no real answer");
});

/** The first sprite's only script, plus whether the project needed any shared proc. */
function lowered(source: string) {
    const { errors, ir } = compileToIR(source);
    assert.ok(ir, errors.map((e) => e.message).join("\n"));
    return { body: ir.sprites[0]!.scripts.at(-1)!.body, procs: [...ir.procs.keys()] };
}

test("small literal powers are plain multiplies with no proc", () => {
    const { body, procs } = lowered(`public b: num = 2; sprite Cat { events.onFlag() { private x: num = b ** 2; } }`);
    assert.deepEqual(procs, []);
    assert.deepEqual(body, [
        {
            kind: "raw",
            opcode: "data_setvariableto",
            inputs: [
                { kind: "var", name: "x" },
                { kind: "op", opcode: "operator_multiply", inputs: [{ kind: "var", name: "b" }, { kind: "var", name: "b" }] },
            ],
        },
    ]);
    assert.deepEqual(lowered(`public b: num = 2; sprite Cat { events.onFlag() { private x: num = b ** 4; } }`).procs, ["katnip_pow"]);
});

test("a base that isn't a plain read is computed once, so a random base squares one roll", () => {
    const { body } = lowered(`sprite Cat { events.onFlag() { private x: num = math.random(1, 6) ** 2; } }`);
    const rolls = JSON.stringify(body).split("operator_random").length - 1;
    assert.equal(rolls, 1);
});

test("a return value used as a base survives a later call", () => {
    const f = `proc f(n: num) -> num { return n; }`;
    assert.equal(says("f(2) ** 2 + f(3)", f), 7);
    assert.equal(says("f(2) ** 2 + f(3) ** 2", f), 13);
    assert.equal(says("(f(2) + 1) ** 2 + f(3)", f), 12);
});

test("a loop condition with an inline power is recomputed every iteration", () => {
    const said = run(`public n: num = 0;
sprite Cat { events.onFlag() { while ((n + 1) ** 2 < 10) { n += 1; } looks.say(f"{n}"); } }`);
    assert.deepEqual(said, [3]);
});

test("short literal string slices are letter blocks with no proc; the rest use str.slice", () => {
    const procsOf = (slice: string) =>
        lowered(`public s: str = "abc"; sprite Cat { events.onFlag() { looks.say(${slice}); } }`).procs;
    assert.deepEqual(procsOf("s[2:4]"), []);
    assert.deepEqual(procsOf("s[:8]"), []);
    assert.deepEqual(procsOf("s[3:1:-1]"), []);
    assert.deepEqual(procsOf("s[:9]"), ["katnip_slice"]);
    assert.deepEqual(procsOf("s[2:]"), ["katnip_slice"]);
    assert.deepEqual(procsOf("s[::-1]"), ["katnip_slice"]);

    const one = lowered(`public s: str = "abc"; sprite Cat { events.onFlag() { looks.say(s[2:2]); } }`);
    assert.equal(JSON.stringify(one.body).split("operator_join").length - 1, 0);
});

test("a computed string is read once by an inline slice", () => {
    const said = run(`public a: str = "ab"; public n: num = 0;
proc next() -> str { n += 1; return a; }
sprite Cat { events.onFlag() { looks.say(next()[1:2]); looks.say(f"{n}"); } }`);
    assert.deepEqual(said, ["ab", 1]);
    assert.equal(says("(a + a)[2:3]", `public a: str = "ab";`), "ba");
});

test("**= and math.pow both reach the same proc", () => {
    const said = run(`sprite Cat { events.onFlag() { private x: num = 3; x **= 2; looks.say(f"{x}"); looks.say(f"{math.pow(2, 5)}"); } }`);
    assert.deepEqual(said, [9, 32]);
});

test("the pow proc only enters a project that uses it", () => {
    const { ir } = compileToIR(`sprite Cat { events.onFlag() { looks.say("hi"); } }`);
    assert.deepEqual([...ir!.procs.keys()], []);
    assert.deepEqual([...ir!.variables.keys()], []);
});

test("two calls in one statement each keep their own return value", () => {
    const f = `proc f(n: num) -> num { return n; } proc g(n: num) -> num { return f(n) * 10; }`;
    assert.equal(says("f(1) + f(2)", f), 3);
    assert.equal(says("f(1) + g(2)", f), 21, "a nested call clobbers the same variable");
    assert.equal(says("f(f(3))", f), 3);
    assert.equal(says("2 ** 3 + 3 ** 2"), 17);
});

test("a condition with two calls is recomputed every iteration", () => {
    const said = run(`public n: num = 0;
proc f(x: num) -> num { return x; }
sprite Cat { events.onFlag() { while (f(n) + f(1) < 4) { n += 1; } looks.say(f"{n}"); } }`);
    assert.deepEqual(said, [3]);
});

test("string slices are 1-based and stop-inclusive", () => {
    const s = `public s: str = "abcdef";`;
    assert.equal(says("s[2:4]", s), "bcd");
    assert.equal(says("s[:2]", s), "ab");
    assert.equal(says("s[5:]", s), "ef");
    assert.equal(says("s[1:5:2]", s), "ace");
    assert.equal(says("s[::-1]", s), "fedcba");
    assert.equal(says("s[4:2:-1]", s), "dcb");
    assert.equal(says("s[5:99]", s), "ef");
    assert.equal(says("s[5:7]", s), "ef");
    assert.equal(says("s[3:3]", s), "c");
    assert.equal(says("s[1:20:3]", s), "ad");
    assert.equal(says("s[4:2]", s), "");
});

test("list slices fill a declaration, a loop and a reassignment", () => {
    const said = run(`public xs: list<num> = [1, 2, 3, 4, 5];
public ys: list<num> = [];
sprite Cat {
    events.onFlag() {
        private part = xs[2:3];
        looks.say(f"{part.length()}{part[2]}");
        for (x, xs[4:]) { looks.say(f"{x}"); }
        ys = xs[::-2];
        looks.say(f"{ys[1]}{ys[3]}");
        xs = xs[2:2];
        looks.say(f"{xs.length()}{xs[1]}");
    }
}`);
    assert.deepEqual(said, ["23", 4, 5, "51", "12"]);
});

test("slices package into a project, including from the top level", () => {
    const { errors, sb3 } = compileToSb3(`public xs: list<num> = [1, 2, 3];
public ys = xs[2:];
public s: str = "abc";
sprite Cat { private zs = xs[:2]; events.onFlag() { looks.say(s[1:2]); looks.say(f"{2 ** 8}"); } }
sprite Dog { private zs = xs[:1]; }`);
    assert.deepEqual(errors, []);
    assert.ok(sb3);
});

test("slice bounds are checked", () => {
    const message = (source: string) => compileToSb3(source).errors.map((e) => e.message).join("\n");
    assert.match(message(`public n: num = 1; sprite Cat { events.onFlag() { looks.say(n[1:2]); } }`), /Cannot slice/);
    assert.match(message(`public s: str = "a"; sprite Cat { events.onFlag() { looks.say(s["a":2]); } }`), /slice bound/);
    assert.match(message(`public s: str = "a"; sprite Cat { events.onFlag() { looks.say(s[1:2:0]); } }`), /step cannot be 0/);
    assert.match(message(`public s: str = "a"; public k: num = 1; sprite Cat { events.onFlag() { looks.say(s[1::k]); } }`), /computed step/);
});

test("tuple patterns unpack var and vstack returns, and swap", () => {
    const flat = run(`proc two() -> (num, num) { return (1, 2); }
sprite Cat { events.onFlag() { private a: num = 0; private b: num = 0; (a, b) = two(); looks.say(f"{a}{b}"); (a, b) = (b, a); looks.say(f"{a}{b}"); two(); } }`);
    assert.deepEqual(flat, ["12", "21"]);

    const cyclic = run(`proc pair(n: num) -> (num, num) {
    if (n == 0) { return (1, 2); }
    private x: num = 0;
    private y: num = 0;
    (x, y) = pair(n - 1);
    return (x + 1, y + 2);
}
sprite Cat { events.onFlag() { private a: num = 0; private b: num = 0; (a, b) = pair(2); looks.say(f"{a}{b}"); } }`);
    assert.deepEqual(cyclic, ["36"]);
});

test("tuple patterns are checked", () => {
    const two = `proc two() -> (num, num) { return (1, 2); }`;
    const message = (body: string) =>
        compileToSb3(`${two} public l: list<num> = [1]; sprite Cat { events.onFlag() { private a: num = 0; private b: num = 0; ${body} } }`)
            .errors.map((e) => e.message).join("\n");
    assert.match(message(`(a, l[1]) = two();`), /plain variables/);
    assert.match(message(`(a, b) += two();`), /cannot assign to a tuple/);
    assert.match(message(`(a, b) = 1;`), /Cannot assign/);
    assert.match(message(`private c: str = ""; (a, c) = two();`), /Cannot assign/);
});

test("constructs with no lowering refuse to build", () => {
    const cases: [string, RegExp][] = [
        [`looks.say("hi"); sprite Cat {}`, /top level/],
        [`sprite Cat { looks.say("hi"); }`, /directly in a sprite/],
        [`public c: list<num> = range(5); sprite Cat {}`, /initialized from a literal/],
        [`public d: dict<str, num> = {}; sprite Cat { events.onFlag() { private k = d.keys(); } }`, /initialized from a literal/],
        [`public a: list<num> = []; public b = a; sprite Cat {}`, /initialized from a literal/],
        [`public a: list<num> = []; public b: list<num> = []; sprite Cat { events.onFlag() { a = b; } }`, /whole list/],
        [`public a: list<num> = []; sprite Cat { events.onFlag() { if (a == a) { } } }`, /whole lists/],
        [`proc two() -> (num, num) { return (1, 2); } sprite Cat { events.onFlag() { private a = two(); } }`, /must be unpacked/],
        [`sprite Cat { events.onFlag() { private t: (num, num) = (1, 2); } }`, /returned or unpacked/],
        [`private p: list<(str, num)> = [("a", 1)]; sprite Cat {}`, /returned or unpacked/],
    ];
    for (const [source, expected] of cases) {
        const { errors, sb3 } = compileToSb3(source);
        assert.equal(sb3, undefined, source);
        assert.match(errors.map((e) => e.message).join("\n"), expected, source);
    }
});

test("writing to an imported value refuses to build", () => {
    const files: Record<string, string> = { "/p/lib.knip": `public x: num = 1;` };
    const { errors, sb3 } = compileToSb3(`import "./lib.knip"; sprite Cat { events.onFlag() { lib.x = 2; } }`, {
        path: "/p/main.knip",
        resolve: () => ({ path: "/p/lib.knip", source: files["/p/lib.knip"]! }),
    });
    assert.equal(sb3, undefined);
    assert.match(errors.map((e) => e.message).join("\n"), /read-only/);
});
