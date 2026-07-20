/**
 * @fileoverview Resolves `import` declarations into parsed modules.
 * All path and I/O handling lives in the host-supplied resolver, so the CLI (fs), the editor (open documents) and the web playground (virtual files) each supply their own.
 * Inspired by https://www.reddit.com/r/ProgrammingLanguages/comments/105jh40/import_mechanisms_in_custom_languages/
 */

import { Lexer } from "../lexer/Lexer.js";
import { Parser } from "../parser/Parser.js";
import { ErrorReporter, KatnipError } from "../utils/ErrorReporter.js";
import { Logger } from "../utils/Logger.js";
import type { AST, ImportDeclarationNode, NodeBase } from "../parser/AST-nodes.js";

/**
 * Turns an import specifier into a module's identity and contents.
 * @param specifier - The literal text between the quotes, e.g. "./thing.knip".
 * @param fromPath - Identity of the importing file, as previously returned by this resolver.
 * @returns The resolved module, or null if it does not exist.
 */
export type ImportResolver = (
    specifier: string,
    fromPath: string,
) => { path: string; source: string } | null;

/** Single `import` declaration after target file is fully parsed. */
export interface ImportedModule {
    namespace: string;
    ast: AST;
    reporter: ErrorReporter;
    sourcePath: string;
    importNode: NodeBase;
    imports: ImportedModule[];
}

/** Stripped down version of import module. */
type ParsedModule = Pick<ImportedModule, "ast" | "reporter" | "imports">;

/** Underlines the quoted path (quotes included) rather than the whole statement. */
function specifierSpan(stmt: ImportDeclarationNode) {
    const { start, end } = stmt.specifierLoc;
    return { line: start.line, column: start.column, endLine: end.line, endColumn: end.column };
}

function defaultNamespace(path: string): string {
    return path.split(/[\\/]/).pop()!.replace(/\.knip$/, "");
}

/**
 * Walks the import graph starting from a parsed file. Each file is read and parsed once;
 * unresolvable specifiers and import cycles are reported against the importing file and skipped.
 * @param ast - The importing file's AST.
 * @param fromPath - The importing file's identity.
 * @param reporter - The importing file's reporter, for resolution errors.
 */
export function loadImports(
    ast: AST,
    fromPath: string,
    resolve: ImportResolver,
    reporter: ErrorReporter,
    logger: Logger = new Logger(),
): ImportedModule[] {
    const parsed = new Map<string, ParsedModule>();
    const inFlight = new Set<string>();

    const walk = (ast: AST, fromPath: string, reporter: ErrorReporter): ImportedModule[] => {
        const modules: ImportedModule[] = [];

        for (const stmt of ast.body) {
            if (stmt.type !== "ImportDeclaration") continue;

            const target = resolve(stmt.specifier, fromPath);
            if (!target) {
                reporter.add(
                    new KatnipError("Import", `Cannot resolve module '${stmt.specifier}'`, specifierSpan(stmt)),
                );
                continue;
            }
            if (inFlight.has(target.path)) {
                reporter.add(
                    new KatnipError("Import", `Circular import cycle through '${stmt.specifier}'`, specifierSpan(stmt)),
                );
                continue;
            }

            let module = parsed.get(target.path);
            if (!module) {
                const moduleReporter = new ErrorReporter(target.source, true);
                const tokens = new Lexer(moduleReporter, logger).tokenize(target.source);
                const moduleAst = new Parser(moduleReporter, logger).parse(tokens) ?? { body: [] };

                inFlight.add(target.path);
                module = { ast: moduleAst, reporter: moduleReporter, imports: walk(moduleAst, target.path, moduleReporter) };
                inFlight.delete(target.path);
                parsed.set(target.path, module);
            }

            modules.push({
                ...module,
                namespace: stmt.alias ?? defaultNamespace(target.path),
                sourcePath: target.path,
                importNode: stmt,
            });
        }

        return modules;
    };

    return walk(ast, fromPath, reporter);
}
