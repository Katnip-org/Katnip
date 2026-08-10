/**
 * @fileoverview IR for lowered procs. Statement lists are flat and Scratch-shaped: no IRExpr ever contains a value-returning call.
 *
 * Flat blocks are just opcode + positional inputs; codegen routes each input to its sb3 input/field/menu slot via scratchDefs.opcodeSlots.
 * An expr bound to a field slot (or an enum arg to a menu slot) must be a lit, except ref-marked fields (VARIABLE/LIST)
 *      (e.g. showVariable's arg must be a plain variable reference). Only what sb3 itself treats specially stays structured: substack control flow, hats, proc calls.
 */

import type { ReturnMethod } from "../semantic/SymbolTable.js";

/** Most basic IR type */
export type IRExpr =
    | { kind: "lit"; value: string | number | boolean } // Literals
    | { kind: "op"; opcode: string; inputs: IRExpr[] } // Operator/reporter
    | { kind: "param"; name: string } // argument_reporter from the proc signature
    | { kind: "var"; name: string } // Variable read; not an op (sb3 input form [12, name, id])
    | { kind: "stackref"; list: string; depth: number; offset?: number }; // For return statements; resolved lazily

/** IR building blocks */
export type IRStmt =
    | { kind: "raw"; opcode: string; inputs: IRExpr[] } // Scratch block with no substack
    | { kind: "call"; proc: string; args: IRExpr[] } // Proc call
    | { kind: "if"; cond: IRExpr; then: IRStmt[]; else: IRStmt[] }
    | { kind: "while"; cond: IRExpr; body: IRStmt[] }
    | { kind: "repeat"; times: IRExpr; body: IRStmt[] } // control_repeat: times runs 1..times inclusive
    | { kind: "for"; iter: string; times: IRExpr; body: IRStmt[] } // control_for_each: iter runs 1..times inclusive
    | { kind: "forever"; body: IRStmt[] };

/** NUMBER -> %n, STRING -> %s, and BOOLEAN -> %b */
export enum paramType { BOOLEAN, STRING, NUMBER }

export interface IRParam {
    name: string;
    type: paramType;
}

export interface IRProc {
    /** Unique (mangled) name; overloads must not share it. Also the procs map key. */
    name: string;
    params: IRParam[];
    proccode?: string;
    returns: ReturnMethod;
    warp: boolean;
    strategy: "var" | "vstack" | null;
    vStackName: string | null;
    retVars: string[];
    // Mangled globals backing this proc's `temp` vars. Scope-less by design:
    // mangling stops two procs colliding, but recursion still clobbers them.
    temps: string[];
    body: IRStmt[];
}

/** One hat script inside a sprite. */
export interface IRScript {
    hatOpcode: string;
    /** Hat args (e.g. event_whenkeypressed KEY_OPTION), routed through opcodeSlots like raw. */
    args: IRExpr[];
    body: IRStmt[];
}

export interface IRSprite {
    name: string;
    scripts: IRScript[];
    variables: string[];
    lists: Map<string, (string | number | boolean)[]>;
    /** Procs declared inside the sprite. */
    procs: Map<string, IRProc>;
}

export interface IRProgram {
    /** Top-level shared procs, keyed by IRProc.name; codegen copies each into the targets that use it. */
    procs: Map<string, IRProc>;
    sprites: IRSprite[];
    /** Stage-owned globals: top-level user vars, retVars, temps. */
    variables: string[];
    /** Stage-owned lists: user lists, vstack vStackNames. Maps to initial contents. */
    lists: Map<string, (string | number | boolean)[]>;
}
