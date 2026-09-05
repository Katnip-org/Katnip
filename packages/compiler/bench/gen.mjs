// Deterministic Katnip source generator for the compile-time benchmarks.
// Nothing here is stored in the repo: every program is rebuilt from (shape, lines, seed).

function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

function counter() {
    let n = 0;
    return (prefix) => `${prefix}${n++}`;
}

// Only forms the whole pipeline lowers to sb3 today (see features.md): no structs, no `**`, no `!=`.
function expr(rand, depth, vars) {
    if (depth <= 0 || rand() < 0.3) {
        return rand() < 0.5 ? vars[Math.floor(rand() * vars.length)] : String(Math.floor(rand() * 100));
    }
    const ops = ["+", "-", "*", "/", "%"];
    const op = ops[Math.floor(rand() * ops.length)];
    return `(${expr(rand, depth - 1, vars)} ${op} ${expr(rand, depth - 1, vars)})`;
}

function cond(rand, vars) {
    const cmp = ["<", ">", "==", "<=", ">="][Math.floor(rand() * 5)];
    const c = `${expr(rand, 1, vars)} ${cmp} ${expr(rand, 1, vars)}`;
    return rand() < 0.3 ? `(${c}) && (${expr(rand, 1, vars)} > 0)` : c;
}

// Each shape is a chunk emitter: (rand, id, chunkIndex) -> { top: string, sprite: string, globals: string }
// `top` is file-level (procs, enums), `sprite` goes inside the sprite body, `globals` are stage vars.
const shapes = {
    // Many small procs with args, locals, branches and a return; one call each.
    procs(rand, id) {
        const name = id("p");
        const vars = ["a", "b", `${name}_x`];
        return {
            top: [
                `proc ${name}(a: num, b: num) -> num {`,
                `    private ${name}_x: num = ${expr(rand, 2, ["a", "b"])};`,
                `    if (${cond(rand, vars)}) {`,
                `        ${name}_x += ${expr(rand, 2, vars)};`,
                `    } else {`,
                `        ${name}_x -= ${expr(rand, 1, vars)};`,
                `    }`,
                `    return ${expr(rand, 2, vars)};`,
                `}`,
                ``,
            ].join("\n"),
            sprite: `        acc += ${name}(${Math.floor(rand() * 50)}, acc);\n`,
            globals: "",
        };
    },

    // Few statements, each a deep expression tree: stresses the Pratt parser and the type checker.
    expressions(rand, id) {
        const v = id("e");
        return {
            top: "",
            sprite: [
                `        ${v} = ${expr(rand, 6, ["acc", "seed"])};`,
                `        acc = (${expr(rand, 5, [v, "acc"])}) % 1000;`,
                `        if (${cond(rand, [v, "acc", "seed"])}) { seed += 1; }`,
                ``,
            ].join("\n"),
            globals: `public ${v}: num = 0;\n`,
        };
    },

    // Nested loops, while, do/while, switch: stresses scope handling and IR block nesting.
    control(rand, id) {
        const i = id("i");
        const j = id("j");
        return {
            top: "",
            sprite: [
                `        for (${i}, ${1 + Math.floor(rand() * 20)}) {`,
                `            for (${j}, range(1, ${2 + Math.floor(rand() * 9)})) {`,
                `                if (${cond(rand, [i, j, "acc"])}) {`,
                `                    acc += ${i} * ${j};`,
                `                } elif (${cond(rand, [i, "acc"])}) {`,
                `                    acc -= ${j};`,
                `                } else {`,
                `                    acc = acc % 97;`,
                `                }`,
                `            }`,
                `            while (acc > 1000) { acc /= 2; }`,
                `            do { acc += 1; } while (acc < 3);`,
                `            switch (acc % 3) {`,
                `                case (0, 1) { seed += 1; }`,
                `                case (2) { seed -= 1; }`,
                `                default { seed = 0; }`,
                `            }`,
                `        }`,
                ``,
            ].join("\n"),
            globals: "",
        };
    },

    // Lists, dicts, indexing, compound assignment through an index, list methods, f-strings.
    collections(rand, id) {
        const l = id("l");
        const d = id("d");
        const k = id("k");
        const lits = Array.from({ length: 5 }, () => Math.floor(rand() * 100)).join(", ");
        return {
            top: "",
            sprite: [
                `        ${l}[1] = ${l}[2] + ${l}[3];`,
                `        ${l}[2] += acc;`,
                `        ${l}.add(acc * 2);`,
                `        ${d}["x"] = ${d}["y"] + 1;`,
                `        for ((${k}, ${k}v), ${d}) { acc += ${k}v; msg = f"{${k}} -> {${k}v}"; }`,
                `        for (${k}e, ${l}) { acc += ${k}e; }`,
                `        if (${l}.contains(acc) && ${l}.length() >= 3) { acc = ${l}.indexOf(acc); }`,
                `        msg = f"acc={acc} len={${l}.length()} first={${l}[1]}";`,
                ``,
            ].join("\n"),
            globals: `public ${l}: list<num> = [${lits}];\npublic ${d}: dict<str, num> = {"x": 1, "y": 2};\n`,
        };
    },

    // Whole extra sprites, each with its own state, procs and handlers. Exercises target emission.
    sprites(rand, id) {
        const s = id("S");
        return {
            top: [
                `sprite ${s} {`,
                `    private hp: num = ${Math.floor(rand() * 100)};`,
                `    private name: str = "${s}";`,
                `    proc hit(dmg: num) -> void {`,
                `        hp -= dmg;`,
                `        if (hp <= 0) { looks.hide(); } else { looks.say(f"{name}: {hp}", 1); }`,
                `    }`,
                `    proc tick() -> num {`,
                `        motion.forward(${Math.floor(rand() * 10)});`,
                `        motion.turn(${Math.floor(rand() * 45)});`,
                `        return hp * ${1 + Math.floor(rand() * 3)};`,
                `    }`,
                `    events.onFlag() {`,
                `        for (i, ${1 + Math.floor(rand() * 10)}) { hit(tick()); wait(0.1); }`,
                `    }`,
                `    events.onBroadcast("hit_${s}") { hit(${Math.floor(rand() * 10)}); }`,
                `}`,
                ``,
            ].join("\n"),
            sprite: `        events.broadcast("hit_${s}");\n`,
            globals: "",
        };
    },
};

// Round-robins single-target shapes so the file looks like real code.
const mixedNames = ["procs", "expressions", "control", "collections"];
shapes.mixed = (rand, id, i) => shapes[mixedNames[i % mixedNames.length]](rand, id);

// Top-level procs plus many sprites. Codegen copies every top-level proc into every target
// (SB3Generator emits ir.procs per sprite), so output grows as procs * sprites. Capped in run.mjs.
shapes.fanout = (rand, id, i) => (i % 2 ? shapes.sprites : shapes.procs)(rand, id);

export const shapeNames = Object.keys(shapes);
/** Shapes whose output is superlinear by construction; the runner skips sizes above this. */
export const shapeCaps = { fanout: 10000 };

/** Builds a program of at least `lines` lines. Same (shape, lines, seed) -> same text. */
export function generate(shape, lines, seed = 1) {
    const emit = shapes[shape];
    if (!emit) throw new Error(`unknown shape '${shape}', want one of ${shapeNames.join(", ")}`);
    const rand = rng(seed);
    const id = counter();
    const top = [], sprite = [], globals = [];
    let count = 0;
    for (let i = 0; count < lines; i++) {
        const c = emit(rand, id, i);
        top.push(c.top); sprite.push(c.sprite); globals.push(c.globals);
        count += lineCount(c.top) + lineCount(c.sprite) + lineCount(c.globals);
    }
    return [
        `# generated: shape=${shape} lines>=${lines} seed=${seed}`,
        `public acc: num = 0;`,
        `public seed: num = ${seed};`,
        `public msg: str = "";`,
        globals.join(""),
        top.join(""),
        `sprite Main {`,
        `    events.onFlag() {`,
        sprite.join(""),
        `        looks.say(f"acc={acc} msg={msg}", 1);`,
        `    }`,
        `}`,
        ``,
    ].join("\n");
}

function lineCount(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
}

// `node bench/gen.mjs <shape> <lines> [seed]` dumps a program to stdout for eyeballing.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").replace(/^.*\//, ""))) {
    const [shape = "mixed", lines = "50", seed = "1"] = process.argv.slice(2);
    process.stdout.write(generate(shape, Number(lines), Number(seed)));
}
