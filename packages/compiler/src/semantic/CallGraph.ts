/**
 * @fileoverview Call-graph cycle detection (Tarjan SCC) over resolved calls.
 * Drives @ret = "auto" and rejects @ret = "var" on cyclic procs, whose failure mode is a silently wrong return value.
 * Inspiration: https://www.geeksforgeeks.org/dsa/tarjan-algorithm-find-strongly-connected-components/
 */

import type {
    CallExpressionNode,
    NodeBase,
    ProcedureDeclarationNode,
} from "../parser/AST-nodes.js";
import type { Signature } from "./SymbolTable.js";

/** Collects every CallExpression in subtree without caring about AST shape. */
export function collectCalls(root: unknown): CallExpressionNode[] {
    const out: CallExpressionNode[] = [];
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
        }
        if (!node || typeof node !== "object") return;
        const record = node as Record<string, unknown>;
        if (record.type === "CallExpression") out.push(node as CallExpressionNode);
        for (const key of Object.keys(record)) {
            if (key === "loc" || key === "comment") continue;
            walk(record[key]);
        }
    };
    walk(root);
    return out;
}

/** Signatures that participate in any call cycle (including self-recursion). Adapted version of Tarjan's algorithm. */
function findCyclicSignatures(
    nodes: Signature[],
    edges: Map<Signature, Signature[]>,
): Set<Signature> {
    let counter = 0;
    const index = new Map<Signature, number>();
    const low = new Map<Signature, number>();
    const onStack = new Set<Signature>();
    const stack: Signature[] = [];
    const cyclic = new Set<Signature>();

    const connect = (v: Signature): void => {
        index.set(v, counter);
        low.set(v, counter);
        counter++;
        stack.push(v);
        onStack.add(v);
        for (const w of edges.get(v) ?? []) {
            if (!index.has(w)) {
                connect(w);
                low.set(v, Math.min(low.get(v)!, low.get(w)!));
            } else if (onStack.has(w)) {
                low.set(v, Math.min(low.get(v)!, index.get(w)!));
            }
        }
        if (low.get(v) === index.get(v)) {
            const scc: Signature[] = [];
            let w: Signature;
            do {
                w = stack.pop()!;
                onStack.delete(w);
                scc.push(w);
            } while (w !== v);
            const selfEdge = scc.length === 1 && (edges.get(v) ?? []).includes(v);
            if (scc.length > 1 || selfEdge) for (const member of scc) cyclic.add(member);
        }
    };

    for (const node of nodes) if (!index.has(node)) connect(node);
    return cyclic;
}

/**
 * Resolves each user proc's return strategy into meta.retResolved.
 * "auto" picks "var" when the proc is in no call cycle, else "vstack".
 * An explicit "var" on a cyclic proc is a hard error.
 */
export function resolveReturnStrategies(
    procs: Map<ProcedureDeclarationNode, Signature>,
    resolutions: Map<CallExpressionNode, Signature>,
    error: (message: string, node: NodeBase) => void, // Pass in error reporter to keep error reporting consistent
): void {
    const userSigs = new Set(procs.values());
    const edges = new Map<Signature, Signature[]>();
    for (const [declaration, sig] of procs) {
        const targets: Signature[] = [];
        for (const call of collectCalls(declaration.body.body)) {
            const target = resolutions.get(call);
            if (target && userSigs.has(target)) targets.push(target);
        }
        edges.set(sig, targets);
    }

    const cyclic = findCyclicSignatures([...userSigs], edges);

    for (const [declaration, sig] of procs) {
        const meta = sig.meta ?? (sig.meta = {});
        if (meta.opcode || meta.lower === "builds" || meta.returns?.kind === "void") continue;
        const requested = meta.ret ?? "auto";
        const inCycle = cyclic.has(sig);
        if (requested === "var" && inCycle) {
            error(
                `@ret = "var" is unsafe on '${declaration.name}': it is part of a call cycle and would silently return wrong values. Use "vstack" or "auto".`,
                declaration,
            );
            meta.retResolved = "vstack";
        } else if (requested === "auto") {
            meta.retResolved = inCycle ? "vstack" : "var";
        } else {
            meta.retResolved = requested;
        }
    }
}
