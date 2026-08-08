import { test } from "node:test";
import assert from "node:assert/strict";
import { Lexer } from "../lexer/Lexer.js";
import { ErrorReporter } from "../utils/ErrorReporter.js";
import { isValuedTokenType, type Token, type ValuedToken } from "../lexer/Token.js";

function lex(source: string) {
    const reporter = new ErrorReporter(source, false);
    const tokens = new Lexer(reporter).tokenize(source);
    return { tokens, reporter };
}

function types(tokens: Token[]): string[] {
    return tokens.map((t) => t.token.type);
}

function valueOf(token: Token): string {
    assert.ok(isValuedTokenType(token.token.type), `expected valued token, got ${token.token.type}`);
    return (token.token as ValuedToken).value;
}

test("identifiers and punctuation", () => {
    const { tokens, reporter } = lex("temp x = y;");
    assert.equal(reporter.hasErrors(), false);
    assert.deepEqual(types(tokens), ["Identifier", "Identifier", "=", "Identifier", ";", "<EOF>"]);
    assert.equal(valueOf(tokens[0]), "temp");
});

test("number literals: int, decimal, scientific, hex", () => {
    const { tokens, reporter } = lex("42 3.14 2e5 1.5e-3 0x1F");
    assert.equal(reporter.hasErrors(), false);
    const numbers = tokens.filter((t) => t.token.type === "Number").map(valueOf);
    assert.deepEqual(numbers, ["42", "3.14", "2e5", "1.5e-3", "0x1F"]);
    assert.deepEqual(types(tokens), ["Number", "Number", "Number", "Number", "Number", "<EOF>"]);
});

test("multiple decimal points is an error", () => {
    const { reporter } = lex("temp x = 1.2.3;");
    assert.equal(reporter.hasErrors(), true);
});

test("string literals with both quote styles and escapes", () => {
    const { tokens, reporter } = lex(`"a\\nb" 'c\\td' "\\u0041"`);
    assert.equal(reporter.hasErrors(), false);
    const strings = tokens.filter((t) => t.token.type === "String").map(valueOf);
    assert.deepEqual(strings, ["a\nb", "c\td", "A"]);
});

test("interpolated string tokenizes into parts", () => {
    const { tokens, reporter } = lex(`f"pre{x + 1}post"`);
    assert.equal(reporter.hasErrors(), false);
    assert.deepEqual(types(tokens), [
        "InterpolatedString", // "pre"
        "Identifier", "+", "Number",
        "InterpolatedStringEnd",
        "InterpolatedString", // "post"
        "<EOF>",
    ]);
    assert.equal(valueOf(tokens[0]), "pre");
    assert.equal(valueOf(tokens[5]), "post");
});

test("operators use maximal munch", () => {
    const { tokens, reporter } = lex("a **= b ** c -> <= == = && !^");
    assert.equal(reporter.hasErrors(), false);
    const ops = types(tokens).filter((t) => t !== "Identifier" && t !== "<EOF>");
    assert.deepEqual(ops, ["**=", "**", "->", "<=", "==", "=", "&&", "!^"]);
});

test("minus before a number lexes as a negative literal, standalone as operator", () => {
    const negative = lex("-5");
    assert.deepEqual(types(negative.tokens), ["Number", "<EOF>"]);
    assert.equal(valueOf(negative.tokens[0]), "-5");

    const binary = lex("a - b");
    assert.deepEqual(types(binary.tokens), ["Identifier", "-", "Identifier", "<EOF>"]);
});

test("comment forms", () => {
    const single = lex("# hello\nx");
    assert.deepEqual(types(single.tokens), ["Comment_SingleExpanded", "Identifier", "<EOF>"]);
    assert.equal(valueOf(single.tokens[0]), "hello");

    const collapsed = lex("#* folded\nx");
    assert.equal(types(collapsed.tokens)[0], "Comment_SingleCollapsed");

    // Ignored comments produce no token at all
    const ignored = lex("#! gone\nx");
    assert.deepEqual(types(ignored.tokens), ["Identifier", "<EOF>"]);

    const multiline = lex("#< spans\nlines >#x");
    assert.equal(types(multiline.tokens)[0], "Comment_MultilineExpanded");

    const multiCollapsed = lex("#> header <#x");
    assert.equal(types(multiCollapsed.tokens)[0], "Comment_MultilineCollapsed");

    const multiIgnored = lex("#[ gone ]#x");
    assert.deepEqual(types(multiIgnored.tokens), ["Identifier", "<EOF>"]);
});

test("unexpected character reports an error and continues", () => {
    const { tokens, reporter } = lex("x $ y");
    assert.equal(reporter.hasErrors(), true);
    assert.deepEqual(types(tokens), ["Identifier", "Identifier", "<EOF>"]);
});

test("token positions are 1-based line/column", () => {
    const { tokens } = lex("a\n  bb");
    assert.deepEqual(tokens[0].start, { line: 1, column: 1 });
    assert.deepEqual(tokens[1].start, { line: 2, column: 3 });
});

test("carriage returns are stripped", () => {
    const { tokens, reporter } = lex("a\r\nb");
    assert.equal(reporter.hasErrors(), false);
    assert.deepEqual(types(tokens), ["Identifier", "Identifier", "<EOF>"]);
    assert.equal(tokens[1].start.line, 2);
});

test("the stream is terminated whatever state the source ends in", () => {
    // Everything downstream stops at <EOF>; a stream without one walks off the end.
    // Only the Start state emits it, so a source ending mid-comment or mid-string
    // used to hand back an unterminated list, and the parser crashed on it.
    for (const source of ["", "# trailing comment", "#< unterminated", `"unterminated`, "x = 1; # tail"]) {
        const { tokens } = lex(source);
        assert.equal(
            types(tokens).at(-1),
            "<EOF>",
            `${JSON.stringify(source)} produced ${JSON.stringify(types(tokens))}`,
        );
    }
});
