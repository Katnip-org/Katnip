// Embeds stdlib/*.knip into src/stdlib.generated.ts and the default costume into src/assets.generated.ts. Run by `prebuild`.
import { createHash } from "node:crypto";
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

// Hash the bytes instead of trusting the filename, since git's line-ending conversion changes them.
const svg = readFileSync(new URL(costume, assets), "utf-8");
const costumeId = createHash("md5").update(svg).digest("hex");

writeFileSync(
    new URL("../src/assets.generated.ts", import.meta.url),
    header +
        `export const defaultCostumeId = ${JSON.stringify(costumeId)};\n` +
        `export const defaultCostumeMd5ext = ${JSON.stringify(`${costumeId}.svg`)};\n` +
        `export const defaultCostumeSvg = ${JSON.stringify(svg)};\n`,
);
