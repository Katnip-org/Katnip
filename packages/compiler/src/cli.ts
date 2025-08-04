#!/usr/bin/env node
import * as fs from "fs/promises";
import { compile } from "./index";
import { Lexer } from "./lexer/Lexer";
import { ErrorReporter } from "./utils/ErrorReporter";

async function main() {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        printUsageAndExit();
    }

    const command = args[0];
    const sourceFile = args[1];
    const outputPath = args[2]; // optional, only for compile

    const source = await fs.readFile(sourceFile, "utf-8");
    const reporter = new ErrorReporter(source);

    if (command === "compile") {
        if (!outputPath) {
            console.error("Output path required for compile command.");
            process.exit(1);
        }
        await compile(source, outputPath, reporter);
    } else if (command === "tokenize") {
        const lexer = new Lexer(reporter);
        const tokens = lexer.tokenize(source);
        console.log("Tokens:", tokens);
    } else {
        console.error(`Unknown command: ${command}`);
        printUsageAndExit();
    }

    // Error handling
    if (reporter.hasErrors()) {
        reporter.print();
        process.exit(1); // Or handle gracefully
    }
}

function printUsageAndExit() {
    console.log(`
Usage:
  compile <sourceFile> <outputPath>   Compile source to output file
  tokenize <sourceFile>               Tokenize source and print tokens
`);
    process.exit(1);
}

if (require.main === module) {
    main();
}
