import { test } from "node:test";
import assert from "node:assert/strict";
import { Lexer } from "../lexer/Lexer.js";
import { Parser } from "../parser/Parser.js";
import { ErrorReporter } from "../utils/ErrorReporter.js";
import type { StatementNode } from "../parser/AST-nodes.js";

function parse(source: string) {
    const reporter = new ErrorReporter(source, false);
    const tokens = new Lexer(reporter).tokenize(source);
    const ast = new Parser(reporter).parse(tokens);
    return { ast: ast!, reporter };
}

/** Parses and asserts no errors, returning the first statement. */
function parseStmt(source: string): StatementNode {
    const { ast, reporter } = parse(source);
    assert.equal(reporter.hasErrors(), false, `unexpected parse errors in: ${source}`);
    return ast.body[0];
}

test("empty list literal parses to ListExpression with no elements", () => {
    const decl = parseStmt("temp e = [];");
    assert.equal(decl.type, "VariableDeclaration");
    if (decl.type !== "VariableDeclaration") return;
    assert.equal(decl.initializer?.type, "ListExpression");
    if (decl.initializer?.type !== "ListExpression") return;
    assert.deepEqual(decl.initializer.elements, []);
});

test("nested and trailing-comma list literals parse", () => {
    const decl = parseStmt("temp e = [[1], [2, 3],];");
    if (decl.type !== "VariableDeclaration" || decl.initializer?.type !== "ListExpression") {
        assert.fail("expected list initializer");
    }
    assert.equal(decl.initializer.elements.length, 2);
    assert.equal(decl.initializer.elements[1].type, "ListExpression");
});

test("empty and populated dict literals parse", () => {
    const empty = parseStmt("temp d = {};");
    if (empty.type !== "VariableDeclaration") assert.fail("expected declaration");
    assert.equal(empty.initializer?.type, "DictExpression");
    if (empty.initializer?.type !== "DictExpression") return;
    assert.deepEqual(empty.initializer.entries, []);

    const full = parseStmt(`temp d = {"a": 1, "b": 2};`);
    if (full.type !== "VariableDeclaration" || full.initializer?.type !== "DictExpression") {
        assert.fail("expected dict initializer");
    }
    assert.equal(full.initializer.entries.length, 2);
});

test("tuple destructuring assignment parses as a statement", () => {
    const stmt = parseStmt("(x, y) = pair(1, 2);");
    assert.equal(stmt.type, "VariableAssignment");
    if (stmt.type !== "VariableAssignment") return;
    assert.equal(stmt.left.type, "TupleExpression");
    assert.equal(stmt.right.type, "CallExpression");
});

test("proc with decorators, defaults, and tuple return type", () => {
    const stmt = parseStmt(`proc f(@opcode = "x_y", @hat, a: num, b: str = "hi") -> (num, str) { }`);
    assert.equal(stmt.type, "ProcedureDeclaration");
    if (stmt.type !== "ProcedureDeclaration") return;
    assert.deepEqual(stmt.decorators.map((d) => d.name), ["opcode", "hat"]);
    assert.deepEqual(stmt.parameters.map((p) => p.name), ["a", "b"]);
    assert.equal(stmt.parameters[1].default?.type, "Literal");
    assert.equal(stmt.returnType?.type, "TupleType");
});

test("binary precedence: multiplication binds tighter than addition", () => {
    const stmt = parseStmt("x = 1 + 2 * 3;");
    if (stmt.type !== "VariableAssignment" || stmt.right.type !== "BinaryExpression") {
        assert.fail("expected binary RHS");
    }
    assert.equal(stmt.right.operator, "+");
    assert.equal(stmt.right.right.type, "BinaryExpression");
    if (stmt.right.right.type !== "BinaryExpression") return;
    assert.equal(stmt.right.right.operator, "*");
});

test("if/elif/else chain shape", () => {
    const stmt = parseStmt(`
        if (a == 1) { x = 1; }
        elif (a == 2) { x = 2; }
        elif (a == 3) { x = 3; }
        else { x = 4; }
    `);
    assert.equal(stmt.type, "IfStatement");
    if (stmt.type !== "IfStatement") return;
    assert.equal(stmt.elifs.length, 2);
    assert.notEqual(stmt.elseBlock, null);
});

test("while and do-while parse", () => {
    const whileStmt = parseStmt("while (x < 10) { x += 1; }");
    assert.equal(whileStmt.type, "WhileStatement");

    const doStmt = parseStmt("do { x += 1; } while (x < 10);");
    assert.equal(doStmt.type, "DoWhileStatement");
});

test("for loops with identifier and tuple patterns", () => {
    const simple = parseStmt("for (i, xs) { y = i; }");
    assert.equal(simple.type, "ForStatement");
    if (simple.type !== "ForStatement") return;
    assert.equal(simple.pattern.type, "Identifier");

    const destructured = parseStmt("for ((k, v), pairs) { y = k; }");
    if (destructured.type !== "ForStatement") assert.fail("expected for");
    assert.equal(destructured.pattern.type, "TupleExpression");
});

test("switch with cases and default", () => {
    const stmt = parseStmt(`
        switch (x) {
            case (1, 2) { y = 1; }
            case (3) { y = 2; }
            default { y = 3; }
        }
    `);
    assert.equal(stmt.type, "SwitchDeclaration");
    if (stmt.type !== "SwitchDeclaration") return;
    assert.equal(stmt.body.length, 3);
    assert.equal(stmt.body[0].type, "CaseDeclaration");
    if (stmt.body[0].type !== "CaseDeclaration") return;
    assert.equal(stmt.body[0].values.length, 2);
    assert.equal(stmt.body[2].type, "DefaultCaseDeclaration");
});

test("return with and without a value", () => {
    const bare = parseStmt("proc f() -> void { return; }");
    if (bare.type !== "ProcedureDeclaration") assert.fail("expected proc");
    const bareReturn = bare.body.body[0];
    assert.equal(bareReturn.type, "ReturnStatement");
    if (bareReturn.type !== "ReturnStatement") return;
    assert.equal(bareReturn.argument, null);

    const valued = parseStmt("proc f() -> num { return 1 + 2; }");
    if (valued.type !== "ProcedureDeclaration") assert.fail("expected proc");
    const valuedReturn = valued.body.body[0];
    if (valuedReturn.type !== "ReturnStatement") assert.fail("expected return");
    assert.equal(valuedReturn.argument?.type, "BinaryExpression");
});

test("member calls, namespace calls, and named arguments", () => {
    const method = parseStmt("xs.remove(2);");
    if (method.type !== "ExpressionStatement" || method.expression.type !== "CallExpression") {
        assert.fail("expected call statement");
    }
    assert.equal(method.expression.object.type, "MemberExpression");

    const named = parseStmt("f(a, b = 2);");
    if (named.type !== "ExpressionStatement" || named.expression.type !== "CallExpression") {
        assert.fail("expected call statement");
    }
    assert.equal(named.expression.arguments[1].type, "NamedArgument");
});

test("indexer access and unary operators", () => {
    const idx = parseStmt("x = xs[0];");
    if (idx.type !== "VariableAssignment") assert.fail("expected assignment");
    assert.equal(idx.right.type, "IndexerAccess");

    const negated = parseStmt("x = !y;");
    if (negated.type !== "VariableAssignment") assert.fail("expected assignment");
    assert.equal(negated.right.type, "UnaryExpression");
});

test("interpolated string parses to parts", () => {
    const stmt = parseStmt(`x = f"a{y}b";`);
    if (stmt.type !== "VariableAssignment") assert.fail("expected assignment");
    assert.equal(stmt.right.type, "InterpolatedString");
    if (stmt.right.type !== "InterpolatedString") return;
    // "a", expr, "b"
    assert.equal(stmt.right.parts.length, 3);
    assert.equal(typeof stmt.right.parts[0], "string");
    assert.equal(typeof stmt.right.parts[2], "string");
});

test("handler statements attach the block to the call", () => {
    const stmt = parseStmt("onflag() { x = 1; }");
    assert.equal(stmt.type, "HandlerStatement");
    if (stmt.type !== "HandlerStatement") return;
    assert.equal(stmt.call.type, "CallExpression");
    assert.equal(stmt.body.body.length, 1);
});

test("'temp' is a variable-only storage class", () => {
    assert.match(parse("temp proc f() -> void { }").reporter.getErrors()[0]?.message ?? "",
        /Procedures cannot be declared 'temp'/);
    assert.match(parse("temp enum E { A }").reporter.getErrors()[0]?.message ?? "",
        /Enums cannot be declared 'temp'/);
    assert.equal(parse("temp x = 1;").reporter.hasErrors(), false);
    assert.equal(parse("private proc f() -> void { }").reporter.hasErrors(), false);
});

test("enum declaration collects members", () => {
    const stmt = parseStmt("enum Color { red, green, blue }");
    assert.equal(stmt.type, "EnumDeclaration");
    if (stmt.type !== "EnumDeclaration") return;
    assert.deepEqual(stmt.members, [
        { name: "red", value: "red" },
        { name: "green", value: "green" },
        { name: "blue", value: "blue" },
    ]);
});

test("enum members accept explicit string and number values", () => {
    const stmt = parseStmt(`enum Target { RANDOM = "_random_", MOUSE = "_mouse_", LEVEL = 2, PLAIN }`);
    assert.equal(stmt.type, "EnumDeclaration");
    if (stmt.type !== "EnumDeclaration") return;
    assert.deepEqual(stmt.members, [
        { name: "RANDOM", value: "_random_" },
        { name: "MOUSE", value: "_mouse_" },
        { name: "LEVEL", value: 2 },
        { name: "PLAIN", value: "PLAIN" },
    ]);
});

test("enum member value must be a literal", () => {
    const { reporter } = parse("enum Bad { A = foo }");
    assert.equal(reporter.hasErrors(), true);
});

test("missing semicolon reports an error but parsing continues", () => {
    const { ast, reporter } = parse("temp a = 1\ntemp b = 2;");
    assert.equal(reporter.hasErrors(), true);
    // The second declaration still lands in the AST.
    assert.ok(ast.body.some((s) => s.type === "VariableDeclaration" && s.name === "b"));
});

test("parser never wedges on garbage input", () => {
    const { reporter } = parse("proc ] ) = = { [ ;");
    assert.equal(reporter.hasErrors(), true);
});
