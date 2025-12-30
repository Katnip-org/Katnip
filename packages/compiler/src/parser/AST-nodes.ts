/**
 * @fileoverview Contains all the AST node interfaces for the Katnip parser.
 */

// Base node interfaces 
export interface AST {
    body: StatementNode[];
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
    isExpanded: boolean;
}

export interface SingleTypeNode extends NodeBase {
    type: "Type";
    typeName: string;
    typeParams?: TypeNode[];
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
    value: ExpressionNode;
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

// Enum Nodes 
export interface EnumDeclarationNode extends NodeBase {
    type: "EnumDeclaration";
    name: string;
    members: (string | number)[];
}

// Statement Nodes
export type StatementNode =
    | ExpressionStatementNode
    | HandlerDeclarationNode
    | ProcedureDeclarationNode
    | EnumDeclarationNode;

export interface HandlerDeclarationNode extends NodeBase {
    type: "HandlerDeclaration";
    call: CallExpressionNode;
    body: BlockNode;
}

export interface ExpressionStatementNode extends NodeBase {
    type: "ExpressionStatement";
    expression: ExpressionNode;
}

// Expression Nodes 
export type ExpressionNode =
    | IdentifierExpressionNode
    | LiteralExpressionNode
    | BinaryExpressionNode
    | CallExpressionNode
    | UnaryExpressionNode
    | MemberExpressionNode
    | EmptyExpressionNode
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

export interface BlockNode extends NodeBase {
    type: "Block";
    body: StatementNode[];
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

export interface EmptyExpressionNode extends NodeBase {
    type: "EmptyExpression";
}

export interface ErrorExpressionNode extends NodeBase {
    type: "ErrorToken";
    value: string;
}