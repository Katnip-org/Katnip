/**
 * @fileoverview Loads the stdlib .knip files shipped with the compiler.
 * Each file defines one namespace (motion.knip -> motion.*); prelude.knip is special-cased by the analyzer and becomes bare globals (typeof, Num, ...).
 */

import { Lexer } from "../lexer/Lexer.js";
import { Parser } from "../parser/Parser.js";
import { ErrorReporter, KatnipError } from "../utils/ErrorReporter.js";
import { Logger } from "../utils/Logger.js";
import { stdlibSources } from "../stdlib.generated.js";
import type { AST } from "../parser/AST-nodes.js";

export interface StdlibModule {
    namespace: string; // Namespace name (file basename), or "prelude" for no namespace (bare globals)
    ast: AST;
    reporter: ErrorReporter; // Custom error reporter instance bound to its source lines
    sourcePath: string;
}

/**
 * Lexes and parses every stdlib file (embedded at build time). Errors here are compiler bugs, not user errors: they are printed with a banner and the load aborts.
 * @throws a locationless KatnipError when any stdlib file fails to lex or parse.
 */
export function loadStdlibModules(logger: Logger = new Logger()): StdlibModule[] {
    // The prelude declares bare globals; load first
    const entries = [...stdlibSources].sort((a, b) =>
        a.name === "prelude.knip" ? -1 : b.name === "prelude.knip" ? 1 : a.name.localeCompare(b.name),
    );

    const modules: StdlibModule[] = [];
    for (const { name, content } of entries) {
        const reporter = new ErrorReporter(content, true);

        const tokens = new Lexer(reporter, logger).tokenize(content);
        const ast = reporter.hasErrors() ? null : new Parser(reporter, logger).parse(tokens);

        if (reporter.hasErrors() || !ast) {
            console.error(
                `Internal compiler error in stdlib file '${name}' (this is a Katnip bug):`,
            );
            reporter.print();
            const [first] = reporter.getErrors();
            throw new KatnipError(
                "Stdlib",
                `stdlib file '${name}' failed to load${first ? `: ${first.message}` : ""}`,
            );
        }

        modules.push({
            namespace: name.replace(/\.knip$/, ""),
            ast,
            reporter,
            sourcePath: name,
        });
    }
    return modules;
}
