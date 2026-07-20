import { Lexer } from "./lexer/Lexer.js";
import { Parser } from "./parser/Parser.js";
import { SemanticAnalyzer } from "./semantic/SemanticAnalyzer.js";
import { loadStdlibModules, type StdlibModule } from "./semantic/StdlibLoader.js";
import { ErrorReporter, type KatnipError } from "./utils/ErrorReporter.js";
import { Logger } from "./utils/Logger.js";

import { loadImports, type ImportResolver } from "./semantic/ModuleLoader.js";

export type { KatnipError } from "./utils/ErrorReporter.js";
export type { ImportResolver } from "./semantic/ModuleLoader.js";

let stdlibCache: StdlibModule[] | null = null;

/**
 * @param options.path - Identity of this source, passed to the resolver as the importing file.
 * @param options.resolve - Host-supplied import resolver; without one, imports fail to resolve.
 */
export function checkSource(
    source: string,
    options: { path?: string; resolve?: ImportResolver } = {},
): readonly KatnipError[] {
    const reporter = new ErrorReporter(source);
    const logger = new Logger(); // disabled by default

    const tokens = new Lexer(reporter, logger).tokenize(source);
    const ast = new Parser(reporter, logger).parse(tokens);
    if (!ast) return reporter.getErrors();

    const analyzer = new SemanticAnalyzer(reporter, logger);
    try {
        stdlibCache ??= loadStdlibModules(logger);
        analyzer.loadStdlib(stdlibCache);
    } catch {
        return reporter.getErrors();
    }

    if (options.resolve)
        analyzer.loadImports(
            loadImports(ast, options.path ?? "", options.resolve, reporter, logger),
        );

    analyzer.analyze(ast);
    return reporter.getErrors();
}
