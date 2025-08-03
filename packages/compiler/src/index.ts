import { Lexer } from "./lexer/Lexer";
import * as fs from "fs/promises";
// import { Parser } from "./parser/Parser";
// import { SemanticAnalyzer } from "./semantic/SemanticAnalyzer";
// import { IRGenerator } from "./ir/IRGenerator";
// import { SB3Generator } from "./codegen/SB3Generator";

export async function compile(source: string, outputPath: string) {
    const lexer = new Lexer();
    const tokens = lexer.tokenize(source);
    console.log("Tokens:", tokens);

    // Create temp file with tokens for debugging
    const tempFilePath = `${outputPath}.tokens.json`;
    await fs.writeFile(tempFilePath, JSON.stringify(tokens, null, 2));

    // const parser = new Parser(tokens);
    // const ast = parser.parse();

    // const semantic = new SemanticAnalyzer();
    // semantic.check(ast);

    // const ir = new IRGenerator().generate(ast);

    // const sb3 = new SB3Generator().generate(ir);
    // await sb3.saveToFile(outputPath);
}
