#!/usr/bin/env node

import * as fs from "fs/promises";
import { Lexer } from "./lexer/Lexer";
import { ErrorReporter } from "./utils/ErrorReporter";
import { Logger } from "./utils/Logger";

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { PathLike } from "fs";

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
                const reporter = new ErrorReporter(fileContent);
                const logger = new Logger();
                if (argv.logger && argv.logger === false) logger.disable();

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
    .help()
    .argv;