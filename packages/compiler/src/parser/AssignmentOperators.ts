export const ASSIGNMENT_OPERATORS = [
    "=",    // =
    "+=",   // +=
    "-=",   // -=
    "*=",   // *=
    "/=",   // /=
    "%=",   // %=
    "**=",  // **=
] as const;

export type AssignmentOperator = typeof ASSIGNMENT_OPERATORS[number];
const assignmentOperatorSet = new Set<string>(
    Object.values(ASSIGNMENT_OPERATORS)
);

export function isAssignmentOperator(type: string): type is AssignmentOperator {
    return assignmentOperatorSet.has(type);
}