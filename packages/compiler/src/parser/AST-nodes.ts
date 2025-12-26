/**
 * @fileoverview Contains all the AST node interfaces for the Katnip parser.
 */

// Base node interfaces 
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

export interface SingleTypeNode extends NodeBase {
    type: "Type";
    typeName: string;
    typeParams?: TypeNode[]; // Optional type parameters for container types
}

export interface UnionTypeNode extends NodeBase {
    type: "UnionType";
    left: TypeNode;
    right: TypeNode;
}

export type TypeNode = SingleTypeNode | UnionTypeNode;

// Procedure nodes 
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
    value: string | number;
}

export interface ParameterNode extends NodeBase {
    type: "Parameter";
    name: string;
    paramType: TypeNode;
    default?: ParameterDefaultNode;
}

export interface ParameterDefaultNode extends NodeBase {
    type: "ParameterDefault";
    value: string;
}

// For loop nodes 
export interface ForLoopNode extends NodeBase {
    type: "ForLoop";
    iterator: string | tupleBinding;
    iterable: ExpressionNode;
    body: NodeBase[];
}

export type tupleBinding = [...string[]];

// Enum Nodes 
export interface EnumDeclarationNode extends NodeBase {
    type: "EnumDeclaration";
    name: string;
    members: (string | number)[];
}

// Expression Nodes 
export type ExpressionNode =
    | IdentifierExpressionNode
    | LiteralExpressionNode
    | BinaryExpressionNode
    | CallExpressionNode
    | UnaryExpressionNode
    | MemberExpressionNode
    | ErrorExpressionNode;

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

export interface UnaryExpressionNode extends NodeBase {
    type: "UnaryExpression";
    operator: string;
    argument: ExpressionNode;
}

export interface MemberExpressionNode extends NodeBase {
    type: "MemberExpression";
    object: ExpressionNode;
    property: IdentifierExpressionNode;
}

export interface ErrorExpressionNode extends NodeBase {
    type: "ErrorToken";
    value: string;
}