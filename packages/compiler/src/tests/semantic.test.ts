import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, expectClean, formatErrors } from "./helpers.js";

/** Compiles and returns the joined error messages ("" when clean). */
function errorsOf(source: string, opts?: { stdlib?: boolean }): string {
    return formatErrors(compile(source, opts).reporter);
}

test("undefined identifiers are reported", () => {
    assert.match(errorsOf("private x = missing;"), /'missing' is not defined/);
});

test("declaration type mismatch is reported", () => {
    assert.match(errorsOf(`private x: num = "hello";`), /cannot be initialized/);
});

test("declaration needs a type or an initializer", () => {
    // The parser already requires `:` or `=` after the name.
    const result = compile("private x;");
    assert.equal(result.reporter.hasErrors(), true);
});

test("assignment type mismatch is reported", () => {
    const errors = errorsOf(`
        private x = 1;
        proc f() -> void { x = "str"; }
    `);
    assert.match(errors, /Cannot assign value of type 'str'/);
});

test("conditions must be bool", () => {
    assert.match(errorsOf("proc f() -> void { if (1) { } }"), /must be of type 'bool'/);
    assert.match(errorsOf("proc f() -> void { while (2) { } }"), /must be of type 'bool'/);
});

test("a repeat count must be num", () => {
    assert.match(errorsOf(`proc f() -> void { repeat ("a") { } }`), /'repeat' count must be of type 'num'/);
    assert.equal(errorsOf("proc f() -> void { repeat (3) { } }"), "");
});

test("return outside a procedure is an error", () => {
    assert.match(errorsOf("return 1;"), /'return' can only be used inside a procedure/);
});

test("return type mismatch is reported", () => {
    assert.match(
        errorsOf(`proc f() -> num { return "s"; }`),
        /not assignable to return type 'num'/,
    );
});

test("call argument checking: missing, extra, unknown named", () => {
    const proc = "proc f(a: num, b: num) -> void { }\n";
    assert.match(errorsOf(proc + "proc g() -> void { f(1); }"), /Missing argument 'b'/);
    assert.match(errorsOf(proc + "proc g() -> void { f(1, 2, 3); }"), /at most 2 positional/);
    assert.match(errorsOf(proc + "proc g() -> void { f(1, c = 2); }"), /no parameter named 'c'/);
    assert.match(errorsOf(proc + "proc g() -> void { f(1, b = 2); f(1, 2); }"), /^$/);
});

test("argument type mismatch names the parameter", () => {
    const errors = errorsOf(`
        proc f(a: num) -> void { }
        proc g() -> void { f("s"); }
    `);
    assert.match(errors, /Argument 'a' expects num, got str/);
});

test("positional argument cannot follow a named argument", () => {
    const errors = errorsOf(`
        proc f(a: num, b: num) -> void { }
        proc g() -> void { f(a = 1, 2); }
    `);
    assert.match(errors, /Positional argument cannot follow a named argument/);
});

test("overloads select by arity", () => {
    const result = compile(`
        proc f(a: num) -> num { return a; }
        proc f(a: num, b: num) -> num { return a + b; }
        proc g() -> num { return f(1) + f(1, 2); }
    `);
    expectClean(result);
});

test("no matching overload is reported", () => {
    const errors = errorsOf(`
        proc f(a: num) -> void { }
        proc f(a: num, b: num) -> void { }
        proc g() -> void { f(1, 2, 3); }
    `);
    assert.match(errors, /No overload of 'f' matches/);
});

test("duplicate declarations conflict, procs may overload", () => {
    assert.match(errorsOf("private x = 1;\nprivate x = 2;"), /already declared/);
    assert.match(errorsOf("proc f() -> void { }\nproc f(a: num) -> void { }"), /^$/);
});

test("hat blocks cannot be called, non-hats cannot be handlers", () => {
    const hat = `proc onthing(@opcode = "event_x", @hat) -> void { }\n`;
    assert.match(
        errorsOf(hat + "sprite s { proc g() -> void { onthing(); } }"),
        /hat block and can only be used as an event handler/,
    );
    assert.match(
        errorsOf("proc notahat() -> void { }\nsprite s { notahat() { } }"),
        /not a hat block/,
    );
    assert.match(errorsOf(hat + "sprite s { onthing() { } }"), /^$/);
});

test("handlers only at sprite top level", () => {
    const errors = errorsOf(`proc h(@opcode = "event_x", @hat) -> void { }\nh() { }`);
    assert.match(errors, /only appear at the top level of a sprite/);
});

test("unknown type annotations are reported", () => {
    assert.match(errorsOf("private x: banana = 1;"), /Unknown type 'banana'/);
});

test("enum member access checks membership", () => {
    const decl = "enum Color { red, green }\n";
    assert.match(errorsOf(decl + "private c: Color = Color.red;"), /^$/);
    assert.match(errorsOf(decl + "private c: Color = Color.purple;"), /has no member 'purple'/);
});

test("namespaced enum members resolve, and stay out of global scope", () => {
    const wrap = (body: string) => `sprite A { events.onFlag() { ${body} } }`;
    const opts = { stdlib: true };
    assert.match(errorsOf(wrap(`motion.setRotationStyle(motion.RotationStyle.LEFT_RIGHT);`), opts), /^$/);
    assert.match(errorsOf(wrap(`motion.setRotationStyle(motion.RotationStyle.SIDEWAYS);`), opts), /has no member 'SIDEWAYS'/);
    assert.match(errorsOf(wrap(`motion.setRotationStyle(RotationStyle.LEFT_RIGHT);`), opts), /'RotationStyle' is not defined/);
});

// -- enum literal coercion --

/** Wraps a statement in the smallest program that reaches the stdlib. */
const inScript = (body: string) => `sprite A { events.onFlag() { ${body} } }`;
const withStdlib = { stdlib: true };

test("a literal that is a member value coerces to the enum, as an argument", () => {
    assert.match(errorsOf(inScript(`pen.setAttr("color", 10);`), withStdlib), /^$/);
    assert.match(errorsOf(inScript(`motion.setRotationStyle("left-right");`), withStdlib), /^$/);
    assert.match(errorsOf(inScript(`sensing.setDragMode("not draggable");`), withStdlib), /^$/);
});

test("a literal that is a member value coerces to the enum, in an assignment", () => {
    const decl = `enum Color { RED = "red", GREEN = "green" }\n`;
    assert.match(errorsOf(decl + `private c: Color = "red";`), /^$/);
    assert.match(errorsOf(decl + `private c: Color = "red";\nproc f() -> void { c = "green"; }`), /^$/);
});

test("a literal that is not a member value is rejected, listing the members", () => {
    const errors = errorsOf(inScript(`pen.setAttr("magenta", 10);`), withStdlib);
    assert.match(errors, /"magenta" is not a value of enum 'ColorParam'/);
    assert.match(errors, /must be one of: "color", "saturation", "brightness", "transparency"/);
});

test("a near-miss literal gets a did-you-mean", () => {
    assert.match(
        errorsOf(inScript(`pen.setAttr("colour", 10);`), withStdlib),
        /Did you mean "color"\?/,
    );
});

test("an enum member reference still works unchanged", () => {
    assert.match(errorsOf(inScript(`pen.setAttr(pen.ColorParam.COLOR, 10);`), withStdlib), /^$/);
    assert.match(
        errorsOf(inScript(`pen.setAttr(pen.ColorParam.MAGENTA, 10);`), withStdlib),
        /has no member 'MAGENTA'/,
    );
});

test("a non-literal of the backing type is rejected, pointing at the member form", () => {
    const errors = errorsOf(
        inScript(`private attr: str = "color"; pen.setAttr(attr, 10);`),
        withStdlib,
    );
    assert.match(errors, /Enum 'ColorParam' expects one of its members here, not a computed 'str'/);
    assert.match(errors, /use a member \(e\.g\. pen\.ColorParam\.COLOR\)/);
    // A concatenation is just as much a reporter as a variable is.
    assert.match(
        errorsOf(inScript(`pen.setAttr("col" + "or", 10);`), withStdlib),
        /expects one of its members here/,
    );
});

test("enum coercion matches by value, so numeric-backed enums work too", () => {
    const decl = `enum Speed { SLOW = 1, FAST = 2 }\n`;
    assert.match(errorsOf(decl + `private s: Speed = 1;`), /^$/);
    assert.match(errorsOf(decl + `private s: Speed = 3;`), /3 is not a value of enum 'Speed'/);
    // A str literal is not a num member value, even when it looks like one.
    assert.match(errorsOf(decl + `private s: Speed = "1";`), /"1" is not a value of enum 'Speed'/);
});

test("case labels check against the switch value's enum", () => {
    const decl = `enum Color { RED = "red", GREEN = "green" }\n`;
    const sw = (labels: string) =>
        errorsOf(decl + `proc f(c: Color) -> void { switch (c) { case (${labels}) { } } }`);
    assert.match(sw(`"red"`), /^$/);
    assert.match(sw(`Color.GREEN`), /^$/);
    assert.match(sw(`"reed"`), /"reed" is not a value of enum 'Color'.*Did you mean "red"\?/);
});

test("the open stdlib menus still take an arbitrary string", () => {
    // Target/TouchTarget/ObjectTarget/CloneTarget/Backdrop menus also list sprite and
    // backdrop names, so those params keep their `| str` arm.
    assert.match(errorsOf(inScript(`motion.goTo("Sprite1");`), withStdlib), /^$/);
    assert.match(errorsOf(inScript(`sensing.touching("Cat");`), withStdlib), /^$/);
    assert.match(errorsOf(inScript(`looks.switchBackdrop("night sky");`), withStdlib), /^$/);
    // A `| str` arm must still not steal the num overload.
    assert.match(errorsOf(inScript(`motion.point(90); motion.point("_mouse_");`), withStdlib), /^$/);
});

test("'self' only valid inside a sprite", () => {
    assert.match(errorsOf("private x = self.y;"), /'self' can only be used inside a sprite/);
});

test("@lower and @ret values are validated", () => {
    assert.match(
        errorsOf(`proc f(@lower = "bogus") -> void { }`),
        /@lower must be one of/,
    );
    assert.match(
        errorsOf(`proc f(@ret = "bogus") -> num { return 1; }`),
        /@ret must be one of/,
    );
    assert.match(errorsOf(`proc f(@ret = "vstack") -> num { return 1; }`), /^$/);
});

test("@lower = \"builds\" requires a body of exactly one return expression", () => {
    assert.match(errorsOf(`proc f(@lower = "builds") -> num { return 1; }`), /^$/);
    assert.match(
        errorsOf(`proc f(@lower = "builds") -> num { }`),
        /must be exactly one 'return <expression>;'/,
    );
    assert.match(
        errorsOf(`proc f(@lower = "builds", a: num) -> num { a = 1; return a; }`),
        /must be exactly one 'return <expression>;'/,
    );
});

test("@operator is only allowed on a builds proc", () => {
    assert.match(errorsOf(`proc f(@lower = "builds", @operator = "^^") -> num { return 1; }`), /^$/);
    assert.match(
        errorsOf(`proc f(@operator = "^^") -> num { return 1; }`),
        /@operator is only valid on a @lower = "builds" proc/,
    );
});

test("list and dict returns on user procs are rejected", () => {
    assert.match(errorsOf("proc f() -> list<num> { return []; }"), /multi-size returns/);
    assert.match(errorsOf("proc f() -> dict<str, num> { return {}; }"), /multi-size returns/);
});

test("stdlib methods and namespaces resolve with types", () => {
    const result = compile(
        `
        private xs = [1, 2, 3];
        proc f() -> void {
            private has = xs.contains(2);
            private n = xs.length();
            console.log("hi");
            wait(1);
        }
    `,
        { stdlib: true },
    );
    expectClean(result);
});

test("stdlib misuse: unknown members and non-methods", () => {
    assert.match(
        errorsOf(`proc f() -> void { console.bogus("x"); }`, { stdlib: true }),
        /Namespace 'console' has no member 'bogus'/,
    );
    assert.match(
        errorsOf(`private n = 1;\nproc f() -> void { n.bogus(); }`, { stdlib: true }),
        /not a method of type 'num'/,
    );
});

test("a public member is visible from other sprites; two sprites cannot claim one name", () => {
    expectClean(
        compile(`sprite Cat { public score: num = 0; }\nsprite Dog { private copy: num = score; }`),
    );
    assert.match(
        errorsOf(`sprite Cat { public score: num = 0; }\nsprite Dog { public score: num = 1; }`),
        /'score' is already declared in this scope/,
    );
    // A private member stays the sprite's own business.
    assert.match(
        errorsOf(`sprite Cat { private lives: num = 9; }\nsprite Dog { private copy: num = lives; }`),
        /'lives' is not defined/,
    );
});

test("for-loop destructuring width is checked", () => {
    const errors = errorsOf(
        `
        private pairs = {"a": 1};
        proc f() -> void {
            for ((k, v, extra), pairs) { }
        }
    `,
        { stdlib: true },
    );
    assert.match(errors, /Cannot destructure/);
});

test("switch validates default placement and count", () => {
    assert.match(
        errorsOf(`
            proc f(x: num) -> void {
                switch (x) {
                    default { }
                    case (1) { }
                }
            }
        `),
        /'default' case not located at bottom/,
    );
    assert.match(
        errorsOf(`
            proc f(x: num) -> void {
                switch (x) {
                    default { }
                    default { }
                }
            }
        `),
        /2 or more 'default' cases/,
    );
});

// -- structs --

const POINT = "struct Point { x: num, y: num }\n";

test("struct literal with all fields is clean", () => {
    assert.match(errorsOf(POINT + "private p: Point = Point(x = 1, y = 2);"), /^$/);
});

test("struct literal fills omitted fields from defaults", () => {
    const decl = "struct Cfg { a: num = 1, b: num = 2 }\n";
    assert.match(errorsOf(decl + "private c: Cfg = Cfg(a = 5);"), /^$/);
});

test("struct literal missing a required field is reported", () => {
    assert.match(errorsOf(POINT + "private p: Point = Point(x = 1);"), /missing required field 'y'/);
});

test("struct literal with an unknown field is reported", () => {
    assert.match(errorsOf(POINT + "private p: Point = Point(x = 1, y = 2, z = 3);"), /has no field 'z'/);
});

test("struct literal field type mismatch is reported", () => {
    assert.match(errorsOf(POINT + `private p: Point = Point(x = 1, y = "no");`), /expects 'num', got 'str'/);
});

test("struct literal rejects positional arguments", () => {
    assert.match(errorsOf(POINT + "private p: Point = Point(1, 2);"), /takes named fields only/);
});

test("field read yields the field type", () => {
    const src = POINT + "private p: Point = Point(x = 1, y = 2);\nprivate bad: str = p.x;";
    assert.match(errorsOf(src), /cannot be initialized/);
});

test("reading a missing field is reported", () => {
    const src = POINT + "private p: Point = Point(x = 1, y = 2);\nprivate z = p.q;";
    assert.match(errorsOf(src), /Struct 'Point' has no field 'q'/);
});

test("field write is type-checked", () => {
    const src = POINT + "private p: Point = Point(x = 1, y = 2);\nproc f() -> void { p.x = \"no\"; }";
    assert.match(errorsOf(src), /Cannot assign value of type 'str'/);
});

test("struct list element field access is clean", () => {
    const src = POINT + "private ps: list<Point> = [];\nprivate a: num = ps[0].x;";
    assert.match(errorsOf(src), /^$/);
});

test("struct list field column is a list of the field type", () => {
    const src = POINT + "private ps: list<Point> = [];\nprivate col: list<num> = ps.x;\nprivate bad: list<str> = ps.y;";
    const errors = errorsOf(src);
    assert.match(errors, /cannot be initialized/); // only the list<str> line
    assert.equal(errors.split("\n").length, 1);
});

test("non-scalar struct fields are rejected", () => {
    assert.match(errorsOf("struct Bad { xs: list<num> }"), /only scalar fields/);
});

test("duplicate struct fields are reported", () => {
    assert.match(errorsOf("struct Bad { x: num, x: num }"), /duplicate field 'x'/);
});

test("struct default type mismatch is reported", () => {
    assert.match(errorsOf(`struct Bad { x: num = "no" }`), /Default for field 'x'/);
});

test("struct-typed params and returns are clean", () => {
    const src = POINT + `
        proc mid(a: Point, b: Point) -> Point {
            return Point(x = a.x, y = b.y);
        }
    `;
    assert.match(errorsOf(src), /^$/);
});

test("an unknown struct name as a type is still an error", () => {
    assert.match(errorsOf("private p: Nope = 1;"), /Unknown type 'Nope'/);
});

// -- bug-fix regressions --

test("an asset outside a sprite gets an asset error, not an import one", () => {
    assert.match(errorsOf(`costume "a.png";`), /Assets can only be declared at the top level of a sprite/);
});

test("a dict's first entry is checked once, and entries after a mismatch are still typed", () => {
    const errors = errorsOf(`private d = {1: missing, 2: "a", 3: other};`);
    assert.equal(errors.match(/'missing' is not defined/g)?.length, 1);
    assert.match(errors, /'other' is not defined/);
});

test("a named argument supplied twice is reported", () => {
    const errors = errorsOf(`proc f(a: num) -> void {} proc g() -> void { f(a = 1, a = 2); }`);
    assert.match(errors, /Named argument 'a' is supplied more than once/);
});

test("the enum member hint names the enum's own member, not a same-prefixed namespace const", () => {
    const errors = errorsOf(
        `enum math { A, B } proc f(c: math) -> void {} proc g() -> void { f("x" + "y"); }`,
        withStdlib,
    );
    assert.match(errors, /e\.g\. math\.A\)/);
});

test("procedure misuse messages use a colon", () => {
    const errors = errorsOf(inScript(`private a = motion.forward; private b = [1].length;`), withStdlib);
    assert.match(errors, /'motion\.forward' is a procedure: call it with/);
    assert.match(errors, /'length' is a method: call it with/);
});

test("a procedure or namespace used as a bare value is reported", () => {
    const errors = errorsOf(
        `proc f() -> num { return 1; } proc g() -> void { private n = f; private m = looks; }`,
        withStdlib,
    );
    assert.match(errors, /'f' is a procedure: call it with/);
    assert.match(errors, /Namespace 'looks' is not a value/);
});

test("a variable cannot be initialized from a void call", () => {
    assert.match(
        errorsOf(inScript(`private x = looks.say("hi");`), withStdlib),
        /Variable 'x' cannot be initialized with a value of type 'void'/,
    );
});

test("iterating a non-iterable is reported", () => {
    assert.match(errorsOf(`proc g() -> void { for (x, true) { } }`), /Cannot iterate over a value of type 'bool'/);
    assert.match(errorsOf(`proc g(l: list<num>) -> void { for (x, l) { } }`), /^$/);
});

test("a module importing the entry file back is a direct cycle", () => {
    const main = `import "./a"; private q = a.v;`;
    const errors = formatErrors(
        compile(main, {
            files: { "/proj/main.knip": main, "/proj/a.knip": `import "./main"; public v = 1;` },
        }).reporter,
    );
    assert.match(errors, /Imported file '\/proj\/a\.knip' has errors: Circular import cycle through '\.\/main'/);
});

test("!= is a comparison", () => {
    expectClean(compile(`private a = 1 != 2; private b: bool = "x" != "y";`, withStdlib));
});

test("dicts and calls accept a trailing comma", () => {
    expectClean(compile(`private d = {"a": 1, "b": 2,}; proc f(a: num, b: num) -> void {} proc g() -> void { f(1, 2,); }`));
});

test("assigning to a parameter is reported", () => {
    assert.match(errorsOf(`proc g(x: num) -> void { x += 1; }`), /Cannot assign to parameter 'x'/);
});

test("logical operators require bool operands", () => {
    assert.match(errorsOf(`private b = 1 && true;`), /Must use '&&' binop with boolean expression types/);
    assert.match(errorsOf(`private b = true || "x";`), /Must use '\|\|' binop with boolean expression types/);
    expectClean(compile(`private b = true && (1 < 2) || false;`));
});

test("an overload with the same parameter types is a redeclaration", () => {
    assert.match(
        errorsOf(`proc f(a: num) -> void {} proc f(b: num) -> void {}`),
        /'f' is already declared in this scope with the same parameter types/,
    );
    expectClean(compile(`proc f(a: num) -> void {} proc f(a: str) -> void {}`));
});

test("case and default are reserved", () => {
    assert.match(errorsOf(`private default = 1;`), /'default' is a reserved word/);
    assert.match(errorsOf(inScript(`case (1) { }`)), /'case' is reserved for switch blocks/);
    expectClean(compile(inScript(`switch (1) { case (1) { } default { } }`), withStdlib));
});

test("a type annotation can name a namespaced enum", () => {
    expectClean(compile(`private e: looks.GraphicEffect = looks.GraphicEffect.GHOST;`, withStdlib));
    assert.match(errorsOf(`private e: looks.Nope = 1;`, withStdlib), /Unknown type 'looks\.Nope'/);
});

test("writing a struct param's field is assigning to a parameter", () => {
    assert.match(
        errorsOf(`struct Point { x: num, y: num } proc f(a: Point) -> void { a.x = 1; }`),
        /Cannot assign to parameter 'a'/,
    );
});
