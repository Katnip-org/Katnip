/**
 * @fileoverview Contains all the AST node interfaces for the Katnip parser.
 */

// -- Base node interfaces --
export interface AST {
    body: NodeBase[];
}

export interface NodeBase {
    type: string;
    loc: SourceLocation;
    comment?: CommentNode;
}

export interface SourceLocation {
    start: { line: number; column: number };
    end: { line: number; column: number };
}

export interface CommentNode {
    type: "Comment";
    loc: SourceLocation;
    content: string;
    isExpanded: boolean; // true -> expanded comment, false -> collapsed comment
}

// -- Procedure nodes --
export interface ProcedureDeclarationNode extends NodeBase {
    type: "ProcedureDeclaration";
    name: string;
    decorators: DecoratorNode[];
    parameters: ParameterNode[];
    returnType: TypeNode | null;
    body: NodeBase[];
}

export interface DecoratorNode extends NodeBase {
    type: "Decorator";
    name: string;
    value: string | ExpressionNode;
}

export interface ParameterNode {
    name: string;
    type: TypeNode;
    default?: string;
}

export interface TypeNode extends NodeBase {
    type: "Type";
    typeName: string;
}

// -- For loop nodes --
export interface ForLoopNode extends NodeBase {
    type: "ForLoop";
    iterator: string | tupleBinding;
    iterable: ExpressionNode;
    body: NodeBase[];
}

export type tupleBinding = [...string[]];

// -- Enum Nodes --
export interface EnumDeclarationNode extends NodeBase {
    type: "EnumDeclaration";
    name: string;
    members: (string | number)[];
}

// -- Expression Nodes --
export type ExpressionNode =
    | IdentifierExpressionNode
    | LiteralExpressionNode
    | BinaryExpressionNode
    | CallExpressionNode;

export interface IdentifierExpressionNode extends NodeBase {
    type: "Identifier";
    name: string;
}

export interface LiteralExpressionNode extends NodeBase {
    type: "Literal";
    value: string | number | null;
    valueType: "string" | "number" | "null";
}

export interface BinaryExpressionNode extends NodeBase {
    type: "BinaryExpression";
    operator: string;
    left: ExpressionNode;
    right: ExpressionNode;
}

export interface CallExpressionNode extends NodeBase {
    type: "CallExpression";
    callee: ExpressionNode;
    arguments: ExpressionNode[];
}