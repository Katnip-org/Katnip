/**
 * @fileoverview Loads the stdlib .knip files shipped with the compiler.
 * Each file defines one namespace (motion.knip -> motion.*); prelude.knip is special-cased by the analyzer and becomes bare globals (typeof, Num, ...).
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { Lexer } from "../lexer/Lexer.js";
import { Parser } from "../parser/Parser.js";
import { ErrorReporter } from "../utils/ErrorReporter.js";
import { Logger } from "../utils/Logger.js";
import type { AST } from "../parser/AST-nodes.js";

export interface StdlibModule {
    namespace: string; // Namespace name (file basename), or "prelude" for no namespace (bare globals)
    ast: AST;
    reporter: ErrorReporter; // Custom error reporter instance bound to its source lines
    sourcePath: string;
}

const STDLIB_DIR = fileURLToPath(new URL("../../stdlib/", import.meta.url));

/**
 * Lexes and parses every stdlib file. Errors here are compiler bugs, not user errors: they are printed with a banner and the load aborts.
 * @throws when any stdlib file fails to lex or parse.
 */
export async function loadStdlibModules(logger: Logger = new Logger()): Promise<StdlibModule[]> {
    const entries = (await fs.readdir(STDLIB_DIR)).filter((f) => f.endsWith(".knip"));
    // The prelude declares bare globals; load first
    entries.sort((a, b) =>
        a === "prelude.knip" ? -1 : b === "prelude.knip" ? 1 : a.localeCompare(b),
    );

    const modules: StdlibModule[] = [];
    for (const entry of entries) {
        const sourcePath = path.join(STDLIB_DIR, entry);
        const content = await fs.readFile(sourcePath, { encoding: "utf-8" });
        const reporter = new ErrorReporter(content, true);

        const tokens = new Lexer(reporter, logger).tokenize(content);
        const ast = reporter.hasErrors() ? null : new Parser(reporter, logger).parse(tokens);

        if (reporter.hasErrors() || !ast) {
            console.error(
                `Internal compiler error in stdlib file '${sourcePath}' (this is a Katnip bug):`,
            );
            reporter.print();
            throw new Error(`stdlib file '${entry}' failed to load`);
        }

        modules.push({
            namespace: path.basename(entry, ".knip"),
            ast,
            reporter,
            sourcePath,
        });
    }
    return modules;
}
