#!/usr/bin/env node

import * as fs from "fs/promises";
import { Lexer } from "./lexer/Lexer.js";
import { Parser } from "./parser/Parser.js";
import { SemanticAnalyzer } from "./semantic/SemanticAnalyzer.js";
import { loadStdlibModules } from "./semantic/StdlibLoader.js";
import { loadImports, type AssetReader, type ImportResolver } from "./semantic/ModuleLoader.js";
import { loadData, loadImportedData } from "./codegen/assets.js";
import { ErrorReporter, KatnipError } from "./utils/ErrorReporter.js";
import { Logger } from "./utils/Logger.js";
import { compileToIR, compileToSb3, decompileSb3 } from "./index.js";

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { PathLike } from "fs";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const fileResolver: ImportResolver = (specifier, fromPath) => {
    const resolved = path.resolve(
        path.dirname(fromPath),
        specifier.endsWith(".knip") ? specifier : `${specifier}.knip`,
    );
    try {
        return { path: resolved, source: readFileSync(resolved, "utf8") };
    } catch {
        return null;
    }
};

const fileAssetReader: AssetReader = (specifier, fromPath) => {
    try { return readFileSync(path.resolve(path.dirname(fromPath), specifier)); } catch { return null; }
};

class FileLogger extends Logger {
    private logFilePath = path.resolve(process.cwd(), "examples", "log.txt");
    protected write(msg: string) { appendFileSync(this.logFilePath, `${msg}\n`, { encoding: "utf8" }); }
}

const cli = yargs(hideBin(process.argv));

cli
    .scriptName('katnip')
    .command('tokenize <source> <output> [logger]', 'Tokenize a file', (yargs: any) => {
        yargs.positional('source', {
            describe: 'The path to the source file',
            type: 'string',
            demandOption: true,
        }).positional('output', {
            describe: 'The path to the output file for tokens',
            type: 'string',
            demandOption: true,
        }).positional('logger', {
            describe: 'Boolean for whether to keep a log or not',
            type: 'boolean',
        });
    }, (argv: any) => {
        fs.readFile(argv.source as PathLike, { encoding: 'utf-8' })
            .then((fileContent: string) => {
                const reporter = new ErrorReporter(fileContent, true);
                const logger = new FileLogger();
                if (argv.logger === true) logger.enable();

                const lexer = new Lexer(reporter, logger);
                const tokens = lexer.tokenize(fileContent);
                if (reporter.hasErrors()) {
                    reporter.print();
                    process.exitCode = 1;
                    return;
                }

                return fs.writeFile(argv.output, JSON.stringify(tokens, null, 2));
            })
            .catch((err: any) => {
                console.error('Error tokenizing file:', err);
                process.exitCode = 1;
            });
    })
    .command('parse <source> <output> [logger]', 'Tokenize and parse a file', (yargs: any) => {
        yargs.positional('source', {
            describe: 'The path to the source file',
            type: 'string',
            demandOption: true,
        }).positional('output', {
            describe: 'The path to the output file for AST',
            type: 'string',
            demandOption: true,
        }).positional('logger', {
            describe: 'Boolean for whether to keep a log or not',
            type: 'boolean',
        });
    }, (argv: any) => {
        fs.readFile(argv.source as PathLike, { encoding: 'utf-8' })
            .then((fileContent: string) => {
                const reporter = new ErrorReporter(fileContent, true);
                const logger = new FileLogger();
                if (argv.logger === true) logger.enable();

                const lexer = new Lexer(reporter, logger);
                const tokens = lexer.tokenize(fileContent);
                if (reporter.hasErrors()) {
                    reporter.print();
                    process.exitCode = 1;
                    return;
                }

                const parser = new Parser(reporter, logger);
                const ast = parser.parse(tokens);

                if (reporter.hasErrors()) {
                    reporter.print();
                    process.exitCode = 1;
                    return;
                }

                return fs.writeFile(argv.output as PathLike, JSON.stringify(ast, null, 2));
            })
            .catch((err: any) => {
                console.error('Error parsing file:', err);
                process.exitCode = 1;
            });
    })
    .command('check <source> [logger]', 'Lex, parse, and run semantic analysis on a file', (yargs: any) => {
        yargs.positional('source', {
            describe: 'The path to the source file',
            type: 'string',
            demandOption: true,
        }).positional('logger', {
            describe: 'Boolean for whether to keep a log or not',
            type: 'boolean',
        });
    }, (argv: any) => {
        fs.readFile(argv.source as PathLike, { encoding: 'utf-8' })
            .then(async (fileContent: string) => {
                const reporter = new ErrorReporter(fileContent, true);
                const logger = new FileLogger();
                if (argv.logger === true) logger.enable();

                const lexer = new Lexer(reporter, logger);
                const tokens = lexer.tokenize(fileContent);
                if (reporter.hasErrors()) {
                    reporter.print();
                    process.exitCode = 1;
                    return;
                }

                const parser = new Parser(reporter, logger);
                const ast = parser.parse(tokens);
                if (!ast) {
                    reporter.print();
                    process.exitCode = 1;
                    return;
                }

                const analyzer = new SemanticAnalyzer(reporter, logger);
                try {
                    analyzer.loadStdlib(loadStdlibModules(logger));
                } catch (err) {
                    if (!(err instanceof KatnipError)) throw err;
                    reporter.add(err); // the loader already printed the stdlib's own located errors
                    reporter.print();
                    process.exitCode = 1;
                    return;
                }

                const sourcePath = path.resolve(argv.source as string);
                const modules = loadImports(ast, sourcePath, fileResolver, reporter, logger);
                loadImportedData(modules, fileAssetReader);
                analyzer.loadImports(modules);
                loadData(ast, sourcePath, fileAssetReader, reporter);
                // Analyze even when parsing reported errors: the parser recovers into a
                // usable AST (error nodes are no-ops in the analyzer), so semantic errors
                // surface alongside syntax errors instead of being hidden behind the first.
                analyzer.analyze(ast);

                reporter.print(); // warnings too, which do not stop a build
                if (reporter.hasErrors()) process.exitCode = 1;
                else console.log('No semantic errors found.');
            })
            .catch((err: any) => {
                console.error('Error checking file:', err);
                process.exitCode = 1;
            });
    })
    .command('build <source> [output]', 'Compile a file to a Scratch .sb3', (yargs: any) => {
        yargs.positional('source', {
            describe: 'The path to the source file',
            type: 'string',
            demandOption: true,
        }).positional('output', {
            describe: 'The path to write the .sb3 to (defaults to the source path with a .sb3 extension)',
            type: 'string',
        }).option('compression', {
            describe: 'Zip deflate level 0-9; lower builds faster but makes a larger .sb3',
            type: 'number',
            default: 6,
        });
    }, (argv: any) => {
        const source = argv.source as string;
        fs.readFile(source as PathLike, { encoding: 'utf-8' })
            .then(async (fileContent: string) => {
                const { errors, sb3 } = compileToSb3(fileContent, {
                    path: path.resolve(source),
                    resolve: fileResolver,
                    readAsset: fileAssetReader,
                    compression: argv.compression,
                });

                const reporter = new ErrorReporter(fileContent, true);
                for (const err of errors) reporter.add(err);
                reporter.print();

                if (!sb3) {
                    process.exitCode = 1;
                    return;
                }

                const output = (argv.output as string | undefined)
                    ?? `${source.replace(/\.knip$/, '')}.sb3`;
                await fs.writeFile(output as PathLike, sb3);
                console.log(`Wrote ${output}`);
            })
            .catch((err: any) => {
                console.error('Error building file:', err);
                process.exitCode = 1;
            });
    })
    .command('lower <source> [output]', 'Lower a file to IR and print it as JSON', (yargs: any) => {
        yargs.positional('source', {
            describe: 'The path to the source file',
            type: 'string',
            demandOption: true,
        }).positional('output', {
            describe: 'The path to write the IR JSON to (defaults to stdout)',
            type: 'string',
        });
    }, (argv: any) => {
        const source = argv.source as string;
        fs.readFile(source as PathLike, { encoding: 'utf-8' })
            .then(async (fileContent: string) => {
                const { errors, ir } = compileToIR(fileContent, {
                    path: path.resolve(source),
                    resolve: fileResolver,
                });

                if (!ir) {
                    const reporter = new ErrorReporter(fileContent, true);
                    for (const err of errors) reporter.add(err);
                    reporter.print();
                    process.exitCode = 1;
                    return;
                }

                // Maps are invisible to JSON.stringify, and the IR is full of them.
                const json = JSON.stringify(ir, (_, v) => v instanceof Map ? Object.fromEntries(v) : v, 2);

                const output = argv.output as string | undefined;
                if (output) {
                    await fs.writeFile(output as PathLike, json);
                    console.log(`Wrote ${output}`);
                } else {
                    console.log(json);
                }
            })
            .catch((err: any) => {
                console.error('Error lowering file:', err);
                process.exitCode = 1;
            });
    })
    .command('decompile <source> [output]', 'Decompile a Scratch .sb3 into .knip source', (yargs: any) => {
        yargs.positional('source', {
            describe: 'The path to the .sb3 file',
            type: 'string',
            demandOption: true,
        }).positional('output', {
            describe: 'The path to write the .knip to (defaults to the source path with a .knip extension)',
            type: 'string',
        });
    }, (argv: any) => {
        const source = argv.source as string;
        fs.readFile(source as PathLike)
            .then(async (sb3: Uint8Array) => {
                const output = (argv.output as string | undefined)
                    ?? `${source.replace(/\.sb3$/i, '')}.knip`;
                await fs.writeFile(output as PathLike, decompileSb3(sb3));
                console.log(`Wrote ${output}`);
            })
            .catch((err: any) => {
                console.error('Error decompiling file:', err instanceof Error ? err.message : err);
                process.exitCode = 1;
            });
    })
    .command('help', 'List all available commands', () => {}, () => {
        cli.showHelp('log');
    })
    .help()
    .argv;
