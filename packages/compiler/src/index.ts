import { Lexer } from "./lexer/Lexer.js";
import { Parser } from "./parser/Parser.js";
import { SemanticAnalyzer } from "./semantic/SemanticAnalyzer.js";
import { loadStdlibModules, type StdlibModule } from "./semantic/StdlibLoader.js";
import { ErrorReporter, type KatnipError } from "./utils/ErrorReporter.js";
import { Logger } from "./utils/Logger.js";

import { loadImports, type ImportResolver } from "./semantic/ModuleLoader.js";
import { IRGenerator } from "./ir/IRGenerator.js";
import { SB3Generator } from "./codegen/SB3Generator.js";
import { packSb3 } from "./codegen/pack.js";

export type { KatnipError } from "./utils/ErrorReporter.js";
export type { ImportResolver } from "./semantic/ModuleLoader.js";

let stdlibCache: StdlibModule[] | null = null;

interface Options {
    path?: string;
    resolve?: ImportResolver;
}

/** Lex, parse and analyze. `ast` is null when the source was too broken to parse. */
function analyze(source: string, options: Options) {
    const reporter = new ErrorReporter(source);
    const logger = new Logger(); // disabled by default

    const tokens = new Lexer(reporter, logger).tokenize(source);
    const ast = new Parser(reporter, logger).parse(tokens);
    if (!ast) return { reporter, ast: null, analyzer: null };

    const analyzer = new SemanticAnalyzer(reporter, logger);
    try {
        stdlibCache ??= loadStdlibModules(logger);
        analyzer.loadStdlib(stdlibCache);
    } catch {
        return { reporter, ast: null, analyzer: null };
    }

    if (options.resolve)
        analyzer.loadImports(
            loadImports(ast, options.path ?? "", options.resolve, reporter, logger),
        );

    analyzer.analyze(ast);
    return { reporter, ast, analyzer };
}

export function checkSource(source: string, options: Options = {}): readonly KatnipError[] {
    return analyze(source, options).reporter.getErrors();
}

/** Compiles to .sb3 bytes. `sb3` is absent when `errors` is non-empty. */
export function compileToSb3(
    source: string,
    options: Options = {},
): { errors: readonly KatnipError[]; sb3?: Uint8Array } {
    const { reporter, ast, analyzer } = analyze(source, options);
    const errors = reporter.getErrors();
    if (errors.length > 0 || !ast || !analyzer) return { errors };

    const ir = new IRGenerator(analyzer).generate(ast);
    return { errors, sb3: packSb3(new SB3Generator().generate(ir)) };
}
