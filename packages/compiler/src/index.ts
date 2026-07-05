import { Lexer } from "./lexer/Lexer.js";
import { Parser } from "./parser/Parser.js";
import { SemanticAnalyzer } from "./semantic/SemanticAnalyzer.js";
import { loadStdlibModules, type StdlibModule } from "./semantic/StdlibLoader.js";
import { ErrorReporter, type KatnipError } from "./utils/ErrorReporter.js";
import { Logger } from "./utils/Logger.js";

export type { KatnipError } from "./utils/ErrorReporter.js";

let stdlibCache: StdlibModule[] | null = null;

export async function checkSource(source: string): Promise<readonly KatnipError[]> {
    const reporter = new ErrorReporter(source);
    const logger = new Logger(); // disabled by default

    const tokens = new Lexer(reporter, logger).tokenize(source);
    const ast = new Parser(reporter, logger).parse(tokens);
    if (!ast) return reporter.getErrors();

    const analyzer = new SemanticAnalyzer(reporter, logger);
    try {
        stdlibCache ??= await loadStdlibModules(logger);
        analyzer.loadStdlib(stdlibCache);
    } catch {
        return reporter.getErrors();
    }
    analyzer.analyze(ast);
    return reporter.getErrors();
}
