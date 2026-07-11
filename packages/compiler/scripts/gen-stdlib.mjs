// Embeds stdlib/*.knip into src/stdlib.generated.ts 
// Run by `prebuild`.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../stdlib/", import.meta.url);
const modules = readdirSync(dir)
    .filter((f) => f.endsWith(".knip"))
    .map((name) => ({ name, content: readFileSync(new URL(name, dir), "utf-8") }));

writeFileSync(
    new URL("../src/stdlib.generated.ts", import.meta.url),
    `// AUTO-GEN'D by scripts/gen-stdlib.mjs; do not edit.\n` +
        `export const stdlibSources: { name: string; content: string }[] =\n` +
        `${JSON.stringify(modules, null, 4)};\n`,
);
