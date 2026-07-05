#!/usr/bin/env node

import * as fs from "fs/promises";
import { Lexer } from "./lexer/Lexer.js";
import { Parser } from "./parser/Parser.js";
import { SemanticAnalyzer } from "./semantic/SemanticAnalyzer.js";
import { loadStdlibModules } from "./semantic/StdlibLoader.js";
import { ErrorReporter } from "./utils/ErrorReporter.js";
import { Logger } from "./utils/Logger.js";

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { PathLike } from "fs";

yargs(hideBin(process.argv))
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
        // Read in the source file
        fs.readFile(argv.source as PathLike, { encoding: 'utf-8' })
            .then((fileContent: string) => {
                // Create an error reporter instance
                const reporter = new ErrorReporter(fileContent, true);
                const logger = new Logger(true);
                
                if (argv.logger === true) logger.enable();
                else logger.disable();

                const lexer = new Lexer(reporter, logger);
                const tokens = lexer.tokenize(fileContent);

                // Create temp file with tokens for debugging
                const tempFilePath = argv.output; // `${outputPath}.tokens.json`;
                fs.writeFile(tempFilePath, JSON.stringify(tokens, null, 2));
            })
            .catch((err: any) => {
                console.error('Error reading file:', err);
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
                const logger = new Logger(true);

                if (argv.logger === true) logger.enable();
                else logger.disable();

                const lexer = new Lexer(reporter, logger);
                console.log("Starting lexing process...");

                console.time("Lexing Time");
                for (let i = 0; i < 1000; i++) {
                  lexer.tokenize(fileContent);
                }
                const tokens = lexer.tokenize(fileContent);
                console.timeEnd("Lexing Time");

                // If lexer produced errors, print and abort
                if (reporter.hasErrors()) {
                    reporter.print();
                    return;
                }

                // console.log("Tokens:", tokens);

                const parser = new Parser(reporter, logger);
                console.log("Starting parsing process...");
                console.time("Parsing Time");
                const ast = parser.parse(tokens);
                console.timeEnd("Parsing Time");

                if (reporter.hasErrors()) {
                    reporter.print();
                    return;
                }

                fs.writeFile(argv.output as PathLike, JSON.stringify(ast, null, 2));
            })
            .catch((err: any) => {
                console.error('Error reading file:', err);
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
                const logger = new Logger(true);

                if (argv.logger === true) logger.enable();
                else logger.disable();

                const lexer = new Lexer(reporter, logger);
                const tokens = lexer.tokenize(fileContent);
                if (reporter.hasErrors()) {
                    reporter.print();
                    return;
                }

                const parser = new Parser(reporter, logger);
                const ast = parser.parse(tokens);
                if (!ast) {
                    reporter.print();
                    return;
                }

                const analyzer = new SemanticAnalyzer(reporter, logger);
                try {
                    analyzer.loadStdlib(await loadStdlibModules(logger));
                } catch {
                    reporter.print(); // surface any parse errors we already collected
                    return; // the stdlib loader already printed its own errors
                }
                // Analyze even when parsing reported errors: the parser recovers into a
                // usable AST (error nodes are no-ops in the analyzer), so semantic errors
                // surface alongside syntax errors instead of being hidden behind the first.
                analyzer.analyze(ast);

                if (reporter.hasErrors()) {
                    reporter.print();
                    return;
                }

                console.log('No semantic errors found.');
            })
            .catch((err: any) => {
                console.error('Error reading file:', err);
            });
    })
    .help()
    .argv;
