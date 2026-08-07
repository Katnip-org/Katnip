import { strToU8, zipSync } from "fflate";

import { defaultCostumeMd5ext, defaultCostumeSvg } from "../assets.generated.js";
import type { Sb3Project } from "./SB3TypeDefs.js";

export function packSb3(project: Sb3Project): Uint8Array {
    return zipSync({
        "project.json": strToU8(JSON.stringify(project)),
        [defaultCostumeMd5ext]: strToU8(defaultCostumeSvg),
    });
}
