import * as ts from "typescript";
import * as cm from "./codeModel";
import { ApiMetadata, EdmEnumType, EdmEntityType, EdmTypeReference, EdmComplexType, OperationMetadata } from "pailingual-odata/src/metadata";

const API_CONTEXT_BASE_TYPE = "IApiContextBase";

export type GeneratorOptions = {
    imports?: string[],
    include?: (string | RegExp)[],
    exclude?: (string | RegExp)[],
    apiContextName?: string,
    apiContextBase?: string,
    afterBuildModel?: (model: cm.Model, metadata?: ApiMetadata) => Promise<void>
}

export async function generate(metadata: ApiMetadata, options: GeneratorOptions = {}) {
    //  const nodes: ts.Node[] = [];
    const model = new cm.Model();
    model.imports.push("import { ApiContext, IApiContextBase, IComplexBase, IEntityBase } from \"pailingual-odata\"");
    if (options.imports && options.imports.length > 0)
        model.imports.push(...options.imports);

    model.contextDeclaration = generateApiContext(model, metadata, options);

    generateOperations(model, metadata, options);

    if (options.afterBuildModel) {
        var p = options.afterBuildModel(model, metadata);
        if (p && p.then)
            await p;
    }

    const nodes = model.toNodeArray();
   
    const resultFile = ts.createSourceFile("", "", ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

    var printer = ts.createPrinter({});
    var code = printer.printList(ts.ListFormat.MultiLine, nodes, resultFile);
    return code;
}

function isIncludeObject(edmObj: EdmEntityType | EdmComplexType | EdmEnumType | OperationMetadata | string, options: GeneratorOptions) {
    const objFullName = typeof edmObj === "string" ? edmObj : edmObj.getFullName();
    return !(
        (options.include && !options.include.some(p => isMatch(objFullName, p)))
        || isExclude(objFullName, options)
    );
}

function isExclude(path: string, options: GeneratorOptions) {
    return options.exclude && options.exclude.some(p => isMatch(path, p));
}

function isMatch(value: string, pattern: string | RegExp): boolean {
    const pattern2 = pattern instanceof RegExp ? pattern : new RegExp(`^${pattern.replace(".", "\.")}$`, "i");
    return value.match(pattern2)!= null;
}

function initEntityType(edmEntityType: EdmEntityType, declaration:cm.InterfaceDeclaration, metadata: ApiMetadata, model: cm.Model, options: GeneratorOptions): cm.InterfaceDeclaration {

    const internalAddProps = function (props: Record<string, EdmTypeReference>) {
        for (const propName of Object.keys(props)) {
            const propPath = [edmEntityType.getFullName(), propName].join(".");
            if (isIncludeObject(propPath, options)) {
                const edmTypeReference = props[propName];
                const typeReference = getTypeReference(edmTypeReference, metadata, model, options);
                if (typeReference) {
                    if (props === edmEntityType.navProperties)
                        declaration.addNavProperty(propName, typeReference);
                    else
                        declaration.addProperty(propName, typeReference, edmTypeReference.nullable);
                }
            }
        }
    }

    edmEntityType.properties && internalAddProps(edmEntityType.properties);
    edmEntityType.navProperties && internalAddProps(edmEntityType.navProperties);

    declaration.comment = edmEntityType.getFullName();

    return declaration;
}

function initEnumType(edmEnumType: EdmEnumType, declaration: cm.EnumDeclaration, options: GeneratorOptions)
{
    for (const memberName of Object.keys(edmEnumType.members))
        declaration.addMember(memberName, edmEnumType.members[memberName]);
    declaration.comment = edmEnumType.getFullName();
}

export function generateApiContext(model: cm.Model, metadata: ApiMetadata, options: GeneratorOptions): cm.InterfaceDeclaration {
    let baseClass = options.apiContextBase || API_CONTEXT_BASE_TYPE;
    let apiContextName = options.apiContextName || (metadata.containerName||"Odata")+"Context"
    const d = new cm.InterfaceDeclaration(apiContextName, baseClass);

    let entitySets = Object.keys(metadata.entitySets)
        .map(name => { return { name, meta: metadata.entitySets[name], isCol: true } });
    let singletons = Object.keys(metadata.singletons)
        .map(name => { return { name, meta: metadata.singletons[name], isCol: false } });

    for (let p of entitySets.concat(
                    singletons)) 
    {
        const propPath = [metadata.containerName, p.name].filter(_ => _).join(".");
        let typeRef = getTypeReference(new EdmTypeReference(p.meta, false, p.isCol), metadata, model, options);
        if (typeRef &&(
            isIncludeObject(propPath, options)
            || (typeof typeRef.type === "object" && !isExclude(propPath, options))
            )
        ) 
            d.addNavProperty(p.name, typeRef)
                .comment = propPath;
    }    

    return d;
}

export function getTypeReference(edmRef: EdmTypeReference, metadata: ApiMetadata, model: cm.Model, options: GeneratorOptions) {
    if (typeof edmRef.type == "string")
        return new cm.TypeReference(edmRef.type, edmRef.collection);
    var resType =
        !isIncludeObject(edmRef.type, options) ? edmRef.type.name :
            edmRef.type instanceof EdmEntityType
                ? model.getOrAddType(edmRef.type, (t, et) => initEntityType(t, et, metadata, model, options)) :
            edmRef.type instanceof EdmEnumType
                ? model.getOrAddType(edmRef.type, (t, ed) => initEnumType(t, ed, options)) :
            undefined;
    if (resType)
        return new cm.TypeReference(resType, edmRef.collection);
}

function generateOperations(model: cm.Model, metadata: ApiMetadata, options: GeneratorOptions) {
    for (let ns of Object.keys(metadata.namespaces))
        for (let operation of metadata.namespaces[ns].operations) {
            if (isIncludeObject(operation, options))
                generateOperation(operation, model, metadata, options);
        }
}

export function generateOperation(operation: OperationMetadata, model: cm.Model, metadata: ApiMetadata, options: GeneratorOptions) {
    let isSetBinded = false;
    let bindToModel: cm.InterfaceDeclaration;
    if (operation.bindingTo) {
        if (!isIncludeObject(operation.bindingTo.type, options))
            return;
        isSetBinded = operation.bindingTo.collection == true;
        bindToModel = model.getOrAddType(operation.bindingTo.type, (t, id) => initEntityType(t, id, metadata, model, options));
    }
    else
        bindToModel = model.contextDeclaration;
    if (bindToModel) {
        if (!bindToModel.operationsRef)
            bindToModel.operationsRef = new cm.OperationsRefDeclaration();

        let operTypeRef: cm.TypeReference;
        if (isSetBinded) {
            if (operation.isAction) 
                operTypeRef = getOperTypeRef(bindToModel.operationsRef.entitysetActions, tr => bindToModel.operationsRef.entitysetActions = tr, operation, model);
            else
                operTypeRef = getOperTypeRef(bindToModel.operationsRef.entitysetFunctions, tr => bindToModel.operationsRef.entitysetFunctions = tr, operation, model);
        }
        else {
            if (operation.isAction)
                operTypeRef = getOperTypeRef(bindToModel.operationsRef.actions, tr => bindToModel.operationsRef.actions = tr, operation, model);
            else
                operTypeRef = getOperTypeRef(bindToModel.operationsRef.functions, tr => bindToModel.operationsRef.functions = tr, operation, model);
        }

        let interfaceDec = operTypeRef.type as cm.OperationsInterfaceDeclaration;
        let returnType = operation.returnType && getTypeReference(operation.returnType, metadata, model, options);
        let params = (operation.parameters || [])
            .map(p =>
                new cm.MethodParameter(
                    p.name,
                    getTypeReference(p.type, metadata, model, options),
                    p.type.nullable
                )
            );
        const methodDeclaration = new cm.MethodDeclaration(operation.name, returnType, params, operation.getFullName());

        interfaceDec.methods.push(methodDeclaration);
    }
}

export function getOperTypeRef(operTypeRef: cm.TypeReference | undefined, setter: (tr: cm.TypeReference) => void, operation: OperationMetadata, model: cm.Model): cm.TypeReference {
    if (!operTypeRef) {
        const bindtoTypeName = (operation.bindingTo && operation.bindingTo.type.name) || model.contextDeclaration.name;
        const prefix = operation.bindingTo && operation.bindingTo.collection ? "EntitySet" : "";
        const sufix = operation.isAction ? "Actions" : "Functions";
        operTypeRef = new cm.TypeReference(
            new cm.OperationsInterfaceDeclaration(
                "_" + bindtoTypeName + prefix + sufix,
                true //export
            )
        )
        setter(operTypeRef);
        model.addType(operTypeRef.type as cm.InterfaceDeclaration);
    }
    return operTypeRef;

}