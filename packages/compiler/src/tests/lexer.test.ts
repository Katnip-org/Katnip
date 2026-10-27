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
    const { tokens, reporter } = lex("private x = y;");
    assert.equal(reporter.hasErrors(), false);
    assert.deepEqual(types(tokens), ["Identifier", "Identifier", "=", "Identifier", ";", "<EOF>"]);
    assert.equal(valueOf(tokens[0]), "private");
});

test("number literals: int, decimal, scientific, hex", () => {
    const { tokens, reporter } = lex("42 3.14 2e5 1.5e-3 0x1F");
    assert.equal(reporter.hasErrors(), false);
    const numbers = tokens.filter((t) => t.token.type === "Number").map(valueOf);
    assert.deepEqual(numbers, ["42", "3.14", "2e5", "1.5e-3", "0x1F"]);
    assert.deepEqual(types(tokens), ["Number", "Number", "Number", "Number", "Number", "<EOF>"]);
});

test("multiple decimal points is an error", () => {
    const { reporter } = lex("private x = 1.2.3;");
    assert.equal(reporter.hasErrors(), true);
});

test("string literals with both quote styles and escapes", () => {
    const { tokens, reporter } = lex(`"a\\nb" 'c\\td' "\\u0041"`);
    assert.equal(reporter.hasErrors(), false);
    const strings = tokens.filter((t) => t.token.type === "String").map(valueOf);
    assert.deepEqual(strings, ["a\nb", "c\td", "A"]);
});

test("unterminated strings are an error", () => {
    assert.equal(lex(`private x = "abc`).reporter.hasErrors(), true);
    assert.equal(lex(`private x = 'abc\\`).reporter.hasErrors(), true);
    assert.equal(lex(`private x = f"abc{y`).reporter.hasErrors(), true);
    assert.equal(lex(`private x = f"abc{y}`).reporter.hasErrors(), true);
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

test("interpolation may contain a string using the other quote", () => {
    const { tokens, reporter } = lex(`f"hi {getName('first')}"; private b = 1;`);
    assert.equal(reporter.hasErrors(), false);
    assert.deepEqual(types(tokens), [
        "InterpolatedString", // "hi "
        "Identifier", "(", "String", ")",
        "InterpolatedStringEnd",
        "InterpolatedString", // ""
        ";", "Identifier", "Identifier", "=", "Number", ";",
        "<EOF>",
    ]);
    assert.equal(valueOf(tokens[3]), "first");
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

test("a comment keeps its first character and an empty comment ends at the newline", () => {
    const plain = lex("#hello\nx");
    assert.equal(valueOf(plain.tokens[0]), "hello");

    const empty = lex("#\nx");
    assert.deepEqual(types(empty.tokens), ["Comment_SingleExpanded", "Identifier", "<EOF>"]);
});

test("minus after an operand is subtraction", () => {
    for (const source of ["x-1", "f()-1", "a[0]-1", "1-2"]) {
        const ops = types(lex(source).tokens).filter((t) => t === "-");
        assert.deepEqual(ops, ["-"], source);
    }
    assert.equal(valueOf(lex("(-1)").tokens[1]), "-1");
});

test("source text <EOF> is not the EOF token", () => {
    const { tokens } = lex("<EOF> x");
    assert.deepEqual(types(tokens), ["<", "Identifier", ">", "Identifier", "<EOF>"]);
});

test("a hex number ending in e does not take a following + as an exponent sign", () => {
    const { tokens } = lex("0xe+1");
    assert.deepEqual(types(tokens), ["Number", "+", "Number", "<EOF>"]);
    assert.equal(valueOf(tokens[0]), "0xe");
});

test("an invalid unicode escape reports once and does not eat the string", () => {
    const { tokens, reporter } = lex(`"\\u12" x`);
    assert.equal(reporter.getErrors().length, 1);
    assert.deepEqual(types(tokens), ["String", "Identifier", "<EOF>"]);
});

test("malformed numbers are an error", () => {
    assert.equal(lex("1e").reporter.hasErrors(), true);
    assert.equal(lex("0b").reporter.hasErrors(), true);
});

test("a comment at end of file is kept, an unterminated multiline one is an error", () => {
    const { tokens } = lex("x # tail");
    assert.deepEqual(types(tokens), ["Identifier", "Comment_SingleExpanded", "<EOF>"]);
    assert.equal(lex("#< open").reporter.hasErrors(), true);
});
