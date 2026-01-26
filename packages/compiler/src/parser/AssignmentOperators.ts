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
