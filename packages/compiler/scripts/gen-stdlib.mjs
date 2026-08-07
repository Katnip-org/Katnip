// Embeds stdlib/*.knip into src/stdlib.generated.ts and the default costume into src/assets.generated.ts. Run by `prebuild`.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const header = `// AUTO-GEN'D by scripts/gen-stdlib.mjs; do not edit.\n`;

const dir = new URL("../stdlib/", import.meta.url);
const modules = readdirSync(dir)
    .filter((f) => f.endsWith(".knip"))
    .map((name) => ({ name, content: readFileSync(new URL(name, dir), "utf-8") }));

writeFileSync(
    new URL("../src/stdlib.generated.ts", import.meta.url),
    header +
        `export const stdlibSources: { name: string; content: string }[] =\n` +
        `${JSON.stringify(modules, null, 4)};\n`,
);
const assets = new URL("../assets/", import.meta.url);
const costume = readdirSync(assets).find((f) => f.endsWith(".svg"));
if (!costume) throw new Error("no default costume svg in assets/");

writeFileSync(
    new URL("../src/assets.generated.ts", import.meta.url),
    header +
        `export const defaultCostumeMd5ext = ${JSON.stringify(costume)};\n` +
        `export const defaultCostumeSvg = ${JSON.stringify(readFileSync(new URL(costume, assets), "utf-8"))};\n`,
);
