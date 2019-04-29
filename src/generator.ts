import * as ts from "typescript";
import { ApiMetadata, EdmEnumType, EdmEntityType, EdmTypeReference, EdmTypes, EdmComplexType, OperationMetadata } from "pailingual-odata/src/metadata";
import { EdmEntityTypeReference } from "pailingual-odata/dist/esm/metadata";
import { fail } from "assert";

const ENTITY_BASE_TYPE = "IEntityBase";
const COMPLEX_BASE_TYPE = "IComplexBase";
const API_CONTEXT_BASE_TYPE = "IApiContextBase";

export type GeneratorOptions = {
    imports?: string[],
    include?: (string | RegExp)[],
    exclude?: (string | RegExp)[],
    apiContextName?: string,
    apiContextBase?: string,
    afterBuildModel?: (nodes: ts.Node[]) => void
}

export function generate(metadata: ApiMetadata, options: GeneratorOptions = {}) {
    const nodes: ts.Node[] = [];

    var imports = ["import { ApiContext, IApiContextBase, IComplexBase, IEntityBase } from \"pailingual-odata\""];

    if (options.imports)
        imports.push(...options.imports);

    nodes.push(
        ...ts.createSourceFile("imports.ts", imports.join(";"), ts.ScriptTarget.Latest).getChildren()[0].getChildren()
    );

    let apiContextNode = generateApiContext(metadata, options);
    nodes.push(...apiContextNode);

    for (const ns of Object.keys(metadata.namespaces)) {
        var nsData = metadata.namespaces[ns];
        for (const typeName of Object.keys(nsData.types)) {
            var typeMetadata = nsData.types[typeName];
            if (isIncludeObject(typeMetadata, options)) {
                if (typeMetadata instanceof EdmEnumType)
                    nodes.push(generateEnumType(typeMetadata, metadata, options));
                else
                    nodes.push(...generateEntityType(typeMetadata, metadata, options));
            }
        }
    }

    if (options.afterBuildModel)
        options.afterBuildModel(nodes);
   
    const resultFile = ts.createSourceFile(
        "someFileName.ts",
        "",
        ts.ScriptTarget.Latest,
  /*setParentNodes*/ false,
        ts.ScriptKind.TS
    );


    var printer = ts.createPrinter({});
    var code = printer.printList(ts.ListFormat.MultiLine, ts.createNodeArray(nodes), resultFile);
    return code
}

function isIncludeObject(edmObj: EdmEntityType | EdmComplexType | EdmEnumType | OperationMetadata, options: GeneratorOptions) {
    const objFullName = edmObj.getFullName();
    return !(
        (options.include && !options.include.some(p => isMatch(objFullName, p)))
        || (options.exclude && options.exclude.some(p => isMatch(objFullName, p)))
    );
}

function isMatch(value: string, pattern: string | RegExp): boolean {
    const pattern2 = pattern instanceof RegExp ? pattern : new RegExp(`^${pattern.replace(".", "\.")}$`, "i");
    return value.match(pattern2)!= null;
}

const exportModifier = ts.createModifier(ts.SyntaxKind.ExportKeyword);
function generateEntityType(edmEntityType: EdmEntityType, metadata: ApiMetadata, options: GeneratorOptions): ts.Node[] {
    const res = [null];
    const entityName = edmEntityType.name;
    var properties: ts.PropertyDeclaration[] = []
    for (const propName of Object.keys(edmEntityType.properties)) {
        const typeReference = edmEntityType.properties[propName];
        const propType: ts.TypeNode = getType(typeReference)
        properties.push(
            ts.createProperty(
                undefined,
                undefined,
                propName,
                typeReference.nullable ? ts.createToken(ts.SyntaxKind.QuestionToken) : undefined,
                propType,
                undefined
            )
        )
    }

    for (const propName of Object.keys(edmEntityType.navProperties)) {
        const edmTypeRef = edmEntityType.navProperties[propName];
        if (isIncludeObject(edmTypeRef.type, options)) {
            const propType = getType(edmTypeRef);
            properties.push(
                ts.createProperty(
                    undefined,
                    undefined,
                    propName,
                    ts.createToken(ts.SyntaxKind.QuestionToken),
                    propType,
                    undefined
                )
            )
        }
    }

    const esOperations = generateOperationInterfaces(metadata, entityName + "EntitySet", { type: edmEntityType, collection: true, nullable: false }, options);
    const entityOperations = generateOperationInterfaces(metadata, entityName, { type: edmEntityType, collection: false, nullable: false }, options);

    if (esOperations.actionsDeclaration) {
        res.push(esOperations.actionsDeclaration);
        properties.push(ts.createProperty(undefined, undefined, "$$EntitySetActions", undefined, ts.createTypeReferenceNode(esOperations.actionsDeclaration.name, undefined), undefined));
    }
    if (esOperations.functionsDeclaration) {
        res.push(esOperations.functionsDeclaration);
        properties.push(ts.createProperty(undefined, undefined, "$$EntitySetFunctions", undefined, ts.createTypeReferenceNode(esOperations.functionsDeclaration.name, undefined), undefined));
    }
    if (entityOperations.actionsDeclaration) {
        res.push(entityOperations.actionsDeclaration);
        properties.push(ts.createProperty(undefined, undefined, "$$Actions", undefined, ts.createTypeReferenceNode(entityOperations.actionsDeclaration.name, undefined), undefined));
    }
    if (entityOperations.functionsDeclaration) {
        res.push(entityOperations.functionsDeclaration);
        properties.push(ts.createProperty(undefined, undefined, "$$Functions", undefined, ts.createTypeReferenceNode(entityOperations.functionsDeclaration.name, undefined), undefined));
    }

    var baseClassIdentifier = getBaseClassIdentifier(edmEntityType)
    var baseClass = ts.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [ts.createExpressionWithTypeArguments(undefined, baseClassIdentifier)]);

    res[0] = ts.createInterfaceDeclaration(null, [exportModifier], entityName, null, [baseClass], properties as any);
    return res;
}

function getBaseClassIdentifier(edmEntityType: EdmEntityType) {
    if (edmEntityType.baseType)
        return ts.createIdentifier(edmEntityType.baseType.name);
    return ts.createIdentifier(edmEntityType instanceof EdmComplexType
        ? COMPLEX_BASE_TYPE
        : ENTITY_BASE_TYPE);
}

const edmTypeMap = {
    [EdmTypes.Boolean]: ts.createTypeReferenceNode("boolean", undefined),
    [EdmTypes.Date]: ts.createTypeReferenceNode("Date", undefined),
    [EdmTypes.DateTimeOffset]: ts.createTypeReferenceNode("Date", undefined),
    [EdmTypes.Decimal]: ts.createTypeReferenceNode("number", undefined),
    [EdmTypes.Double]: ts.createTypeReferenceNode("number", undefined),
    [EdmTypes.Guid]: ts.createTypeReferenceNode("string", undefined),
    [EdmTypes.Int16]: ts.createTypeReferenceNode("number", undefined),
    [EdmTypes.Int32]: ts.createTypeReferenceNode("number", undefined),
    [EdmTypes.Single]: ts.createTypeReferenceNode("boolean", undefined),
    [EdmTypes.String]: ts.createTypeReferenceNode("string", undefined),
    [EdmTypes.TimeOfDay]: ts.createTypeReferenceNode("Date", undefined)
}

function getType(typeReference: EdmTypeReference): ts.TypeNode {
    var t = typeReference.type instanceof EdmEnumType ? ts.createTypeReferenceNode(typeReference.type.name, undefined) :
            typeReference.type instanceof EdmEntityType ? ts.createTypeReferenceNode(typeReference.type.name, undefined) :
            edmTypeMap[typeReference.type as EdmTypes];
    if (typeReference.collection)
        t = ts.createArrayTypeNode(t);
    return t;
}

function generateEnumType(edmEnumType: EdmEnumType, metadata: ApiMetadata, options: GeneratorOptions): ts.Node
{
    const members = [];
    for (const memberName of Object.keys(edmEnumType.members)) {
        members.push(
            ts.createEnumMember(memberName, ts.createLiteral(edmEnumType.members[memberName]))
        )
    }
    return ts.createEnumDeclaration(undefined, [exportModifier], edmEnumType.name, members);
}

function generateApiContext(metadata: ApiMetadata, options: GeneratorOptions): ts.DeclarationStatement[]
{
    const res: ts.DeclarationStatement[] = [];
    const apiContextName = options.apiContextName || "OdataApiContext";
    const apiContextInterfaceName = "I" + apiContextName;

    res.push(
        ts.createTypeAliasDeclaration(
            undefined,
            [exportModifier],
            apiContextName,
            undefined,
            ts.createTypeReferenceNode("ApiContext", [ts.createTypeReferenceNode(apiContextInterfaceName, undefined)]))
    );


    var props: ts.PropertyDeclaration[] = [];
    for (let esName of Object.keys(metadata.entitySets)) {
        const esMetadata = metadata.entitySets[esName];
        if (isIncludeObject(esMetadata, options)) {
            let propType = ts.createArrayTypeNode(
                ts.createTypeReferenceNode(esMetadata.name, undefined));
            let prop = ts.createProperty(undefined, undefined, esName, undefined, propType, undefined);
            props.push(prop as any)
        }
    }

    for (let sName of Object.keys(metadata.singletons)) {
        const sMetadata = metadata.singletons[sName];
        if (isIncludeObject(sMetadata, options)) {
            let propType = ts.createTypeReferenceNode(sMetadata.name, undefined);
            let prop = ts.createProperty(undefined, undefined, sName, undefined, propType, undefined);
            props.push(prop);
        }
    }

    const operations = generateOperationInterfaces(metadata, apiContextName, undefined, options);
    if (operations.actionsDeclaration) {
        res.push(operations.actionsDeclaration);
        props.push(ts.createProperty(undefined, undefined, "$$Actions", undefined, ts.createTypeReferenceNode(operations.actionsDeclaration.name, undefined), undefined));
    }
    if (operations.functionsDeclaration) {
        res.push(operations.functionsDeclaration);
        props.push(ts.createProperty(undefined, undefined, "$$Functions", undefined, ts.createTypeReferenceNode(operations.functionsDeclaration.name, undefined), undefined));
    }

    let baseClass = options.apiContextBase || API_CONTEXT_BASE_TYPE;
    let baseClassNode = ts.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [ts.createExpressionWithTypeArguments(undefined, ts.createIdentifier(baseClass))]);
    res.splice(1, 0,
        ts.createInterfaceDeclaration(
            undefined,
            [exportModifier],
            apiContextInterfaceName,
            undefined,
            [baseClassNode],
            props as any
        )
    );

    return res;
}

function generateOperations(name: string, operations: OperationMetadata[], options: GeneratorOptions): ts.InterfaceDeclaration {
    let funcs = [];
    for (const operation of operations) {
        let retType: ts.TypeNode = operation.returnType
            ? getType(operation.returnType)
            : ts.createTypeReferenceNode("void", undefined);
        const parameters = getParameterDeclarations(operation, options);
        const funcDeclaration = ts.createMethod(
            undefined,
            undefined,
            undefined,
            operation.name,
            undefined,
            undefined,
            parameters,
            retType,
            undefined
        );
        funcs.push(funcDeclaration);
    }
    return ts.createInterfaceDeclaration(
        undefined,
        [exportModifier],
        name,
        undefined,
        undefined,
        funcs
    );
}

function generateOperationInterfaces(metadata: ApiMetadata, interfaceNamePrefix: string, bindingTo: EdmEntityTypeReference| undefined, options: GeneratorOptions) {
    const actions: OperationMetadata[] = [],
          functions: OperationMetadata[] = [];
    for (const ns of Object.keys(metadata.namespaces)) {
        for (const md of metadata.namespaces[ns].operations)
            if (isIncludeObject(md, options)
                && (md.bindingTo == bindingTo
                || (bindingTo && md.bindingTo && md.bindingTo.type == bindingTo.type && md.bindingTo.collection == bindingTo.collection))
            ) {
                if (md.isAction)
                    actions.push(md);
                else
                    functions.push(md)
            }
    }

    let actionsDeclaration: ts.InterfaceDeclaration,
        functionsDeclaration: ts.InterfaceDeclaration;
    if (actions.length > 0) 
        actionsDeclaration = generateOperations("_"+interfaceNamePrefix + "Actions", actions, options);

    if (functions.length > 0) 
        functionsDeclaration = generateOperations("_"+interfaceNamePrefix + "Functions", functions, options);

    return { actionsDeclaration, functionsDeclaration };
}

function getParameterDeclarations(operation: OperationMetadata, options:GeneratorOptions): ts.ParameterDeclaration[]{
    const res: ts.ParameterDeclaration[] = [];
    for (const paramMd of operation.parameters || []) {
        const name = paramMd.name;
        const type = getType(paramMd.type)
        const paramDeclaration = ts.createParameter(
            undefined,
            undefined,
            undefined,
            name,
            undefined,
            type,
            undefined
        );
        res.push(paramDeclaration);
    }
    return res;
}