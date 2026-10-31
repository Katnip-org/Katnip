import { Lexer } from "./lexer/Lexer.js";
import { Parser } from "./parser/Parser.js";
import { SemanticAnalyzer } from "./semantic/SemanticAnalyzer.js";
import { loadStdlibModules, type StdlibModule } from "./semantic/StdlibLoader.js";
import { ErrorReporter, KatnipError } from "./utils/ErrorReporter.js";
import { Logger } from "./utils/Logger.js";

import { loadImports, type AssetReader, type ImportResolver } from "./semantic/ModuleLoader.js";
import { IRGenerator } from "./ir/IRGenerator.js";
import type { IRProgram } from "./ir/IRNode.js";
import { SB3Generator } from "./codegen/SB3Generator.js";
import { packSb3 } from "./codegen/pack.js";
import { loadAssets, loadData, loadImportedData } from "./codegen/assets.js";

export { KatnipError } from "./utils/ErrorReporter.js";
export type { AssetReader, ImportResolver } from "./semantic/ModuleLoader.js";
export type { IRProgram } from "./ir/IRNode.js";
export { decompileProject, decompileSb3 } from "./decompiler/index.js";

let stdlibCache: StdlibModule[] | null = null;

interface Options {
    path?: string;
    resolve?: ImportResolver;
    readAsset?: AssetReader;
    /** Zip deflate level 0-9 for the .sb3; default 6. Lower is faster to build and larger on disk. */
    compression?: number;
}

/** A file's first line can mark it as stdlib source, so it checks on its own. It can't be built: typevars have no lowering. */
export const isStdlibSource = (source: string) => /^#![ \t]*katnip:[ \t]*stdlib[ \t]*\r?(\n|$)/.test(source);

/** Lex, parse and analyze. `ast` is null when the source was too broken to parse. */
function analyze(source: string, options: Options) {
    const reporter = new ErrorReporter(source);
    const logger = new Logger();

    const tokens = new Lexer(reporter, logger).tokenize(source);
    const ast = new Parser(reporter, logger).parse(tokens);
    if (!ast) return { reporter, ast: null, analyzer: null, assets: null };

    const analyzer = new SemanticAnalyzer(reporter, logger);
    try {
        stdlibCache ??= loadStdlibModules(logger);
        analyzer.loadStdlib(stdlibCache);
    } catch (err) {
        if (!(err instanceof KatnipError)) throw err;
        reporter.add(err);
        return { reporter, ast: null, analyzer: null, assets: null };
    }

    // No reader means every declared asset is "missing", which is a clearer failure than a silent default costume.
    const read = options.readAsset ?? (() => null);
    if (options.resolve) {
        const modules = loadImports(ast, options.path ?? "", options.resolve, reporter, logger);
        loadImportedData(modules, read);
        analyzer.loadImports(modules);
    }

    loadData(ast, options.path ?? "", read, reporter);
    const assets = loadAssets(ast, options.path ?? "", read, reporter);

    if (isStdlibSource(source)) analyzer.checkAsStdlib();
    analyzer.analyze(ast);
    return { reporter, ast, analyzer, assets };
}

function stdlibBuildError(): KatnipError {
    return new KatnipError("Compiler", "this file is marked '#! katnip: stdlib', so it can only be checked, not built", { line: 1, column: 1 });
}

export function checkSource(source: string, options: Options = {}): readonly KatnipError[] {
    return analyze(source, options).reporter.getErrors();
}

/** Lowers to IR. `ir` is absent when `errors` holds anything of severity "error". */
export function compileToIR(
    source: string,
    options: Options = {},
): { errors: readonly KatnipError[]; ir?: IRProgram } {
    const { reporter, ast, analyzer } = analyze(source, options);
    if (isStdlibSource(source)) reporter.add(stdlibBuildError());
    const errors = reporter.getErrors();
    if (reporter.hasErrors() || !ast || !analyzer) return { errors };

    try {
        return { errors, ir: new IRGenerator(analyzer).generate(ast) };
    } catch (err) {
        if (!(err instanceof KatnipError)) throw err;
        reporter.add(err);
        return { errors: reporter.getErrors() };
    }
}

/** Compiles to .sb3 bytes. `sb3` is absent when `errors` holds anything of severity "error". */
export function compileToSb3(
    source: string,
    options: Options = {},
): { errors: readonly KatnipError[]; sb3?: Uint8Array } {
    const { reporter, ast, analyzer, assets } = analyze(source, options);
    if (isStdlibSource(source)) reporter.add(stdlibBuildError());
    const errors = reporter.getErrors();
    if (reporter.hasErrors() || !ast || !analyzer) return { errors };

    if (!ast.body.some((s) => s.type === "SpriteDeclaration"))
        reporter.add(new KatnipError("Compiler", "no sprites declared, so this builds to an empty project", undefined, "warning"));

    try {
        const ir = new IRGenerator(analyzer).generate(ast);
        return { errors: reporter.getErrors(), sb3: packSb3(new SB3Generator().generate(ir, assets), assets, options.compression) };
    } catch (err) {
        if (!(err instanceof KatnipError)) throw err;
        reporter.add(err);
        return { errors: reporter.getErrors() };
    }
}
