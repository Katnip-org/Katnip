/**
 * Minimal ANSI colorizer, drop in for picocolors.
 */
const proc = globalThis.process;
const useColor = proc?.env?.NO_COLOR == null && proc?.stdout?.isTTY === true;

const wrap =
    (open: number, close: number) =>
    (s: string): string =>
        useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const pc = {
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    gray: wrap(90, 39),
    white: wrap(37, 39),
    bold: wrap(1, 22),
};
