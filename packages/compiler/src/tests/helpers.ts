import { Lexer } from "../lexer/Lexer.js";
import { Parser } from "../parser/Parser.js";
import { SemanticAnalyzer } from "../semantic/SemanticAnalyzer.js";
import { loadStdlibModules } from "../semantic/StdlibLoader.js";
import { ErrorReporter } from "../utils/ErrorReporter.js";
import { Logger } from "../utils/Logger.js";
import type { AST } from "../parser/AST-nodes.js";

export interface CompileResult {
    ast: AST;
    reporter: ErrorReporter;
    analyzer: SemanticAnalyzer;
}

export function compile(source: string, { stdlib = false } = {}): CompileResult {
    const reporter = new ErrorReporter(source, false);
    const logger = new Logger();
    const tokens = new Lexer(reporter, logger).tokenize(source);
    const ast = new Parser(reporter, logger).parse(tokens);
    if (!ast) throw new Error(`parse failed:\n${formatErrors(reporter)}`);
    const analyzer = new SemanticAnalyzer(reporter, logger);
    if (stdlib) analyzer.loadStdlib(loadStdlibModules(logger));
    analyzer.analyze(ast);
    return { ast, reporter, analyzer };
}

export function formatErrors(reporter: ErrorReporter): string {
    return reporter
        .getErrors()
        .map((e) => `[${e.source}] ${e.message} (line ${e.location.line})`)
        .join("\n");
}

export function expectClean(result: CompileResult): void {
    if (result.reporter.hasErrors()) {
        throw new Error(`expected no errors, got:\n${formatErrors(result.reporter)}`);
    }
}
