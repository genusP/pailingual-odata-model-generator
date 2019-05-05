import * as ts from "typescript";
import { EdmComplexType, EdmEntityType, EdmEnumType, EdmTypes } from "pailingual-odata/src/metadata";

const ENTITY_BASE_TYPE = "IEntityBase";
const COMPLEX_BASE_TYPE = "IComplexBase";


export abstract class TypeDeclaration {
    constructor(
        public name: string,
        public isExport: boolean
    ) { }

    getModifiers() {
        return this.isExport ? [ts.createToken(ts.SyntaxKind.ExportKeyword)] : undefined;
    }

    abstract toTsNode(): ts.Node;
}

export class InterfaceDeclaration extends TypeDeclaration {
    constructor(
        name: string,
        public baseClass: InterfaceDeclaration | string,
        readonly properties: PropertyDeclaration[] = [],
        readonly navigation: PropertyDeclaration[] = [],
        public operationsRef?: OperationsRefDeclaration,
        public isExport = true,
        public comment?: string
    ) {
        super(name, isExport);
    }

    addNavProperty(name: string, typeRef: TypeReference)
    {
        let prop = new PropertyDeclaration(name, typeRef, true);
        this.navigation.push(prop);
        return prop;
    }
    addProperty(name: string, typeRef: TypeReference, isNullable = false)
    {
        let prop = new PropertyDeclaration(name, typeRef, isNullable);
        this.properties.push(prop);
        return prop;
    }
    
    toTsNode(): ts.Node
    {
        const heritageClause = this.baseClass
            ? [
                ts.createHeritageClause(
                    ts.SyntaxKind.ExtendsKeyword,
                    [ts.createExpressionWithTypeArguments(undefined, ts.createIdentifier(typeof this.baseClass == "string" ? this.baseClass : this.baseClass.name))])]
            : undefined;

        let res: ts.Node = ts.createInterfaceDeclaration(
            undefined,
            this.getModifiers(),
            this.name,
            undefined,
            heritageClause,
            [
                ...this.properties.map((m, i) => this.commentFirst(m.toTypeElement(), i, "Properties")),
                ...this.navigation.map((n, i) => this.commentFirst(n.toTypeElement(), i, "Navigation properties")),
                ...(this.operationsRef ? this.operationsRef.toTypeElements() : [])
            ]
        );

        if (this.comment)
            ts.addSyntheticLeadingComment(res, ts.SyntaxKind.SingleLineCommentTrivia, this.comment, true)
        return res;
    }

    private commentFirst(node: ts.TypeElement, index: number, text: string) {
        return index == 0
            ? ts.addSyntheticLeadingComment(node, ts.SyntaxKind.SingleLineCommentTrivia, text, true)
            : node;
    }

}

export class EnumDeclaration extends TypeDeclaration {
    constructor(name: string, public isExport = true, public comment?: string) {
        super(name, isExport);
    }

    members: { name: string, value: string|number }[] = [];

    addMember(name: string, value: string | number) {
        if (!name)
            throw Error("Name must be not empty");
        if (!value)
            throw Error("Value must be not empty");
        if (this.members.find(v => v.name === name || v.value == value))
            throw Error("Enum already contains member with this name or value");
        return this.members.push({ name, value });
    }

    toTsNode(): ts.Node {
        const res = ts.createEnumDeclaration(
            undefined,
            this.getModifiers(),
            this.name,
            this.members.map(m =>
                ts.createEnumMember(m.name, ts.createLiteral(m.value)))
        )
        if (this.comment)
            return ts.addSyntheticLeadingComment(res, ts.SyntaxKind.SingleLineCommentTrivia, this.comment, true);
        return res;
    }
}

export class PropertyDeclaration {
    constructor(
        readonly name: string,
        public type: TypeReference,
        public isNullable = false,
        public comment?: string
    ) { }

    toTypeElement(): ts.TypeElement {
        var node = ts.createProperty(
            undefined,
            undefined,
            this.name,
            !this.isNullable ? undefined : ts.createToken(ts.SyntaxKind.QuestionToken),
            this.type.toTypeNode(),
            undefined
        ) as any;

        if (this.comment)
            node = ts.addSyntheticTrailingComment(node, ts.SyntaxKind.SingleLineCommentTrivia, this.comment);
        return node;
    }
}

export class TypeReference {
    constructor(
        public type: TypeDeclaration | EdmTypes | string,
		public isArray = false)
    {
    }

    toTypeNode(): ts.TypeNode
    {
        const typeName = typeof this.type === "string"
            ? edmTypeMap[this.type] || this.type
            : this.type.name;

        let typeNode: ts.TypeNode = ts.createTypeReferenceNode(typeName, undefined);
        if (this.isArray)
            typeNode = ts.createArrayTypeNode(typeNode);
        return typeNode;
    }
}

export class OperationsRefDeclaration {
    functions?: TypeReference;
    actions?: TypeReference;
    entitysetActions?: TypeReference;
    entitysetFunctions?: TypeReference;

    toTypeElements(): ts.TypeElement[]{
        return [
            { name: "$$EntitySetActions", ref: this.entitysetActions },
            { name: "$$EntitySetFunctions", ref: this.entitysetFunctions },
            { name: "$$Actions", ref: this.actions },
            { name: "$$Functions", ref: this.functions },
        ]
            .filter(_ => _.ref)
            .map(_ => ts.createProperty(
                undefined,
                undefined,
                _.name,
                undefined,
                _.ref.toTypeNode(),
                undefined
            ) as any);
    }
}

export class OperationsInterfaceDeclaration extends TypeDeclaration
{
    readonly methods: MethodDeclaration[] = [];
    toTsNode(): ts.Node {
        return ts.createInterfaceDeclaration(
            undefined,
            this.getModifiers(),
            this.name,
            undefined,
            undefined,
            this.methods.map(_ => _.toTypeElement())
        )
    }
}

export class MethodDeclaration {
    constructor(
        readonly name: string,
        public returnType?: TypeReference,
        readonly parameters: ReadonlyArray<MethodParameter> = [],
        public comment?: string
    ) { }

    toTypeElement(): ts.TypeElement {
        const res = ts.createMethod(
            undefined,
            undefined,
            undefined,
            this.name,
            undefined,
            undefined,
            this.parameters.map(_ => _.toParameterDeclaration()),
            this.returnType ? this.returnType.toTypeNode() : undefined,
            undefined
        ) as any;

        if (this.comment)
            return ts.addSyntheticLeadingComment(res, ts.SyntaxKind.SingleLineCommentTrivia, this.comment);
        return res;
    }
}

export class MethodParameter {
    constructor(
        readonly name: string,
        public typeRef: TypeReference,
        public isNullable=false
    ) { }

    toParameterDeclaration(): ts.ParameterDeclaration {
        let typeNode = this.typeRef.toTypeNode();
        if (this.isNullable)
            typeNode = ts.createUnionTypeNode([typeNode, ts.createTypeReferenceNode("undefined", undefined)])
        return ts.createParameter(
            undefined,
            undefined,
            undefined,
            this.name,
            undefined,
            typeNode
        );
    }
}

export class Model {
    imports: string[]=[];
    contextDeclaration?: InterfaceDeclaration;
    get typeDeclarations(): ReadonlyArray<TypeDeclaration> {
        return Array.from(this._typeMap.values()).filter(_ => _);
    }

    private _typeMap = new Map<string, TypeDeclaration>();

    getOrAddType<T extends EdmEntityType | EdmComplexType>(type: T, init: (edmType: T, declaration: InterfaceDeclaration) => void): InterfaceDeclaration;
    getOrAddType(type: EdmEnumType, init: (edmType: EdmEnumType, declaration:EnumDeclaration) => void): EnumDeclaration;
    getOrAddType(edmType: EdmEntityType | EdmComplexType | EdmEnumType, init: (edmType, declaration) => void ): InterfaceDeclaration | EnumDeclaration
    {
        var fullName = edmType.getFullName();
        if (this._typeMap.has(fullName))
            return this._typeMap.get(fullName) as any;

        const declaration =
            edmType instanceof EdmComplexType ? new InterfaceDeclaration(edmType.name, COMPLEX_BASE_TYPE) :
                edmType instanceof EdmEntityType ? new InterfaceDeclaration(edmType.name, ENTITY_BASE_TYPE) :
                    new EnumDeclaration(edmType.name, true);

        this._typeMap.set(fullName, declaration);
        init && init(edmType, declaration);
        return declaration;
    }

    addType(typeDeclaration: TypeDeclaration) {
        if (this._typeMap.has(typeDeclaration.name))
            throw Error(`Type '${typeDeclaration.name}' already exists`);
        this._typeMap.set(typeDeclaration.name, typeDeclaration);
    }

    toNodeArray(): ts.NodeArray<ts.Node> {
        const nodes = this.imports
            ? ts.createSourceFile("imports.ts", this.imports.join(";"), ts.ScriptTarget.Latest).getChildren()[0].getChildren()
            : [];
        if (this.contextDeclaration) {
            let apiContextInterfaceName = this.contextDeclaration.name;
            if (apiContextInterfaceName[0] != "I")
                this.contextDeclaration.name = apiContextInterfaceName = "I" + apiContextInterfaceName;
            let apiContextName = apiContextInterfaceName.substr(1);
            nodes.push(this.createApiContextAlias(apiContextName))
            nodes.push(this.contextDeclaration.toTsNode());
        }
        if (this.typeDeclarations)
            nodes.push(...this.typeDeclarations.map(t => t.toTsNode()));
        return ts.createNodeArray(nodes);
    }

    private createApiContextAlias(name: string) {
        return ts.createTypeAliasDeclaration(
            undefined,
            [ts.createToken(ts.SyntaxKind.ExportKeyword)],
            name,
            undefined,
            ts.createTypeReferenceNode("ApiContext",
                [ts.createTypeReferenceNode(this.contextDeclaration.name, undefined)]
            )
        );
    }
}

const edmTypeMap = {
    [EdmTypes.Boolean]: "boolean",
    [EdmTypes.Date]: "Date",
    [EdmTypes.DateTimeOffset]: "Date",
    [EdmTypes.Decimal]: "number",
    [EdmTypes.Double]: "number",
    [EdmTypes.Guid]: "string",
    [EdmTypes.Int16]: "number",
    [EdmTypes.Int32]: "number",
    [EdmTypes.Single]: "boolean",
    [EdmTypes.String]: "string",
    [EdmTypes.TimeOfDay]: "Date"
}
