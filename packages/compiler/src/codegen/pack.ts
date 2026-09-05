import { strToU8, zipSync } from "fflate";

import { defaultCostumeMd5ext, defaultCostumeSvg } from "../assets.generated.js";
import type { AssetTable } from "./assets.js";
import type { Sb3Project } from "./SB3TypeDefs.js";

/** Files are keyed by md5ext, so the same bytes used from several sprites land in the zip once. */
export function packSb3(project: Sb3Project, assets: AssetTable = new Map()): Uint8Array {
    return zipSync({
        "project.json": strToU8(JSON.stringify(project)),
        [defaultCostumeMd5ext]: strToU8(defaultCostumeSvg),
        ...Object.fromEntries([...assets.values()].map((a) => [a.md5ext, a.bytes])),
    });
}
