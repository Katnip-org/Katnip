import { Lexer } from "./lexer/Lexer.js";
import { ErrorReporter } from "./utils/ErrorReporter.js";
import { Logger } from "./utils/Logger.js";

import * as fs from "fs/promises";
import { Parser } from "./parser/Parser.js";
// import { SemanticAnalyzer } from "./semantic/SemanticAnalyzer.js";
// import { IRGenerator } from "./ir/IRGenerator.js";
// import { SB3Generator } from "./codegen/SB3Generator.js";

export async function compile(source: string, outputPath: string) {
    // Create an error reporter instance
    const reporter = new ErrorReporter(source);
    const logger = new Logger();
    //logger.disable();

    const lexer = new Lexer(reporter, logger);
    const tokens = lexer.tokenize(source);

    // Create temp file with tokens for debugging
    const tempFilePath = outputPath; // `${outputPath}.tokens.json`;
    await fs.writeFile(tempFilePath, JSON.stringify(tokens, null, 2));

    const parser = new Parser(reporter, logger);
    const ast = parser.parse(tokens);

    // const semantic = new SemanticAnalyzer();
    // semantic.check(ast);

    // const ir = new IRGenerator().generate(ast);

    // const sb3 = new SB3Generator().generate(ir);
    // await sb3.saveToFile(outputPath);
}
