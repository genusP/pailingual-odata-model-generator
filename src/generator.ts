import * as ts from "typescript";
import * as cm from "./codeModel";
import * as csdl from "pailingual-odata/src/csdl";

const API_CONTEXT_BASE_TYPE = "IApiContextBase";

export type GeneratorOptions = {
    imports?: string[],
    include?: (string | RegExp)[],
    exclude?: (string | RegExp)[],
    apiContextName?: string,
    apiContextBase?: string,
    afterBuildModel?: (model: cm.Model, metadata?: csdl.MetadataDocument) => Promise<void>
}

export async function generate(metadata: csdl.MetadataDocument, options: GeneratorOptions = {}) {
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

function isIncludeObject(edmObj: csdl.EntityType | csdl.ComplexType | csdl.EnumType | csdl.Action | csdl.Function | string, options: GeneratorOptions) {
    const objFullName = typeof edmObj === "string" ? edmObj : csdl.getName(edmObj, "full");
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
    return value.match(pattern2) != null;
}

function initEntityType(type: csdl.EntityType | csdl.ComplexType, declaration: cm.InterfaceDeclaration, model: cm.Model, options: GeneratorOptions): cm.InterfaceDeclaration {
    for (var propName of Object.getOwnPropertyNames(type)) {
        if (propName == "$Key") {
            const v = type[propName] as csdl.KeyItem[];
            declaration.key = v.map(k => typeof k === "string" ? k : Object.getOwnPropertyNames(k)[0]);

        }
        if (propName[0] !== "$") {
            const property = csdl.getProperty(propName, type);
            if (property
                && isIncludeObject(csdl.getName(property, "full"), options)) {
                const typeReference = getTypeReference(property.$Type, property, property.$Collection, model, options);
                if (typeReference) {
                    if (csdl.isNavigationProperty(property))
                        declaration.addNavProperty(propName, typeReference);
                    else if (csdl.isProperty(property))
                        declaration.addProperty(propName, typeReference, property.$Nullable);
                }
            }
        }
    }

    declaration.comment = csdl.getName(type, "full");

    return declaration;
}

function initEnumType(edmEnumType: csdl.EnumType, declaration: cm.EnumDeclaration, options: GeneratorOptions) {
    for (const memberName of Object.keys(edmEnumType))
        if (memberName && memberName[0] !== "$")
            declaration.addMember(memberName, edmEnumType[memberName] as any);
    declaration.comment = csdl.getName(edmEnumType, "full");
}

export function generateApiContext(model: cm.Model, metadata: csdl.MetadataDocument, options: GeneratorOptions): cm.InterfaceDeclaration {
    const container = csdl.getEntityContainer(metadata);
    const containerName = csdl.getName(container);
    let baseClass = options.apiContextBase || API_CONTEXT_BASE_TYPE;
    let apiContextName = options.apiContextName || (containerName || "Odata") + "Context"
    const d = new cm.InterfaceDeclaration(apiContextName, baseClass);

    for (let p of Object.getOwnPropertyNames(container)) {
        const val = container[p]
        if (csdl.isEntitySet(val) || csdl.isSingleton(val)) {
            const propPath = csdl.getName(val, "full");
            let typeRef = getTypeReference(val.$Type, val, val.$Kind == "EntitySet", model, options);
            if (typeRef && (
                isIncludeObject(propPath, options)
                || (typeof typeRef.type === "object" && !isExclude(propPath, options))
            )
            )
                d.addNavProperty(csdl.getName(val), typeRef)
                    .comment = propPath;
        }
    }

    return d;
}

export function getTypeReference(type: string, context: any, collection: boolean | undefined, model: cm.Model, options: GeneratorOptions) {
    const typeDef = csdl.getType(type, context);
    if (csdl.isPrimitiveType(typeDef))
        return new cm.TypeReference(typeDef, collection);
    const fullName = csdl.getName(typeDef, "full");
    const name = csdl.getName(typeDef);
    var resType =
        !isIncludeObject(fullName, options) ? name :
            csdl.isEntityType(typeDef) || csdl.isComplexType(typeDef)
                ? model.getOrAddType(typeDef, (t, et) => initEntityType(t, et, model, options)) :
                csdl.isEnumType(typeDef)
                    ? model.getOrAddType(typeDef, (t, ed) => initEnumType(t, ed, options)) :
                    undefined;
    if (resType)
        return new cm.TypeReference(resType, collection);
}

function generateOperations(model: cm.Model, metadata: csdl.MetadataDocument, options: GeneratorOptions) {
    for (let operation of csdl.getOperations(metadata)) {
        if (isIncludeObject(operation.name, options))
            for (let overload of operation.metadata)
                generateOperation(overload, model, options);
    }
}

export function generateOperation(operation: csdl.ActionOverload | csdl.FunctionOverload, model: cm.Model, options: GeneratorOptions) {
    let isSetBinded = false;
    let bindToModel: cm.InterfaceDeclaration;
    if (operation.$IsBound) {
        const bindingParameter = operation.$Parameter[0];
        const boundTo = csdl.getType(bindingParameter.$Type, operation) as csdl.EntityType;
        if (!isIncludeObject(boundTo, options))
            return;
        isSetBinded = bindingParameter.$Collection == true;
        bindToModel = model.getOrAddType(boundTo, (t, id) => initEntityType(t, id, model, options));
    }
    else
        bindToModel = model.contextDeclaration;
    if (bindToModel) {
        if (!bindToModel.operationsRef)
            bindToModel.operationsRef = new cm.OperationsRefDeclaration();

        let operTypeRef: cm.TypeReference;
        if (isSetBinded) {
            if (csdl.isActionOverload(operation))
                operTypeRef = getOperTypeRef(bindToModel.operationsRef.entitysetActions, tr => bindToModel.operationsRef.entitysetActions = tr, operation, model);
            else
                operTypeRef = getOperTypeRef(bindToModel.operationsRef.entitysetFunctions, tr => bindToModel.operationsRef.entitysetFunctions = tr, operation, model);
        }
        else {
            if (csdl.isActionOverload(operation))
                operTypeRef = getOperTypeRef(bindToModel.operationsRef.actions, tr => bindToModel.operationsRef.actions = tr, operation, model);
            else
                operTypeRef = getOperTypeRef(bindToModel.operationsRef.functions, tr => bindToModel.operationsRef.functions = tr, operation, model);
        }

        let interfaceDec = operTypeRef.type as cm.OperationsInterfaceDeclaration;
        let returnType = operation.$ReturnType && getTypeReference(operation.$ReturnType.$Type, operation, operation.$ReturnType.$Collection, model, options);
        let params = (operation.$Parameter || [])
            .map(p =>
                new cm.MethodParameter(
                    p.$Name,
                    getTypeReference(p.$Type, operation, p.$Collection, model, options),
                    p.$Nullable
                )
            );
        const methodDeclaration = new cm.MethodDeclaration(
            csdl.getName((operation as any).$$parent),
            returnType,
            params,
            csdl.getName((operation as any).$$parent, "full"));

        interfaceDec.methods.push(methodDeclaration);
    }
}

export function getOperTypeRef(operTypeRef: cm.TypeReference | undefined, setter: (tr: cm.TypeReference) => void, operation: csdl.ActionOverload | csdl.FunctionOverload, model: cm.Model): cm.TypeReference {
    if (!operTypeRef) {
        const bindingParameter = operation.$IsBound && operation.$Parameter[0];
        const bindingTo: any = bindingParameter && csdl.getType(bindingParameter.$Type, operation);
        const bindtoTypeName = (bindingTo && csdl.getName(bindingTo)) || model.contextDeclaration.name;
        const prefix = bindingParameter && bindingParameter.$Collection ? "EntitySet" : "";
        const sufix = csdl.isActionOverload(operation) ? "Actions" : "Functions";
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