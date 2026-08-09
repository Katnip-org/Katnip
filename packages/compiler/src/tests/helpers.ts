import { Lexer } from "../lexer/Lexer.js";
import { Parser } from "../parser/Parser.js";
import { SemanticAnalyzer } from "../semantic/SemanticAnalyzer.js";
import { loadStdlibModules } from "../semantic/StdlibLoader.js";
import { ErrorReporter } from "../utils/ErrorReporter.js";
import { Logger } from "../utils/Logger.js";
import { loadImports, type ImportResolver } from "../semantic/ModuleLoader.js";
import { posix } from "node:path";
import type { AST } from "../parser/AST-nodes.js";

export interface CompileResult {
    ast: AST;
    reporter: ErrorReporter;
    analyzer: SemanticAnalyzer;
}

/** Entry path used when `files` is given, so specifiers resolve relative to a known directory. */
export const ENTRY_PATH = "/proj/main.knip";

/** Import resolver over an in-memory file map, keyed by absolute posix path. */
export function virtualResolver(files: Record<string, string>): ImportResolver {
    return (specifier, fromPath) => {
        const resolved = posix.resolve(
            posix.dirname(fromPath),
            specifier.endsWith(".knip") ? specifier : `${specifier}.knip`,
        );
        return resolved in files ? { path: resolved, source: files[resolved] } : null;
    };
}

export function compile(
    source: string,
    { stdlib = false, files }: { stdlib?: boolean; files?: Record<string, string> } = {},
): CompileResult {
    const reporter = new ErrorReporter(source, false);
    const logger = new Logger();
    const tokens = new Lexer(reporter, logger).tokenize(source);
    const ast = new Parser(reporter, logger).parse(tokens);
    if (!ast) throw new Error(`parse failed:\n${formatErrors(reporter)}`);
    const analyzer = new SemanticAnalyzer(reporter, logger);
    if (stdlib) analyzer.loadStdlib(loadStdlibModules(logger));
    if (files)
        analyzer.loadImports(
            loadImports(ast, ENTRY_PATH, virtualResolver(files), reporter, logger),
        );
    analyzer.analyze(ast);
    return { ast, reporter, analyzer };
}

export function formatErrors(reporter: ErrorReporter): string {
    return reporter
        .getErrors()
        .map((e) => `[${e.source}] ${e.message} (line ${e.location?.line ?? "?"})`)
        .join("\n");
}

export function expectClean(result: CompileResult): void {
    if (result.reporter.hasErrors()) {
        throw new Error(`expected no errors, got:\n${formatErrors(result.reporter)}`);
    }
}
