#!/usr/bin/env node

import * as commander from "commander";
import * as fs from "fs";
import * as path from "path";
import { createProgram, ModuleKind, ScriptTarget, Program, DiagnosticCategory } from "typescript";
import fetch from "node-fetch";
import { generate, GeneratorOptions } from "./generator";
import { ApiMetadata } from "pailingual-odata/src/metadata";

if (typeof window === 'undefined') {
    require('jsdom-global')();
    (global as any).DOMParser = (window as any).DOMParser;
}

class CLI extends commander.Command {
    imports: string[];
    force: boolean;
    include: (string | RegExp)[];
    exclude: (string | RegExp)[];
    contextName: string;
    contextBase: string;
    afterBuild: string;
    verbose: boolean;
}

var urlOrPath: string = null;
var outFile: string = null;
const packageInfo = require("../package.json");
const cli = commander.version(packageInfo.version)
    .option("-i --imports <imports>", "List of import declarations (semicolon separated) to be added to output file", v => v.split(";").filter(_ => _))
    .option("-f --force", "Overwrite existing output file")
    .option("--include <pattern>", "Types an operations included to model. Semicolon separated list of strings or js regex patterns.", parseNamespacesOption)
    .option("--exclude <pattern>", "Types an operations not included to model. Semicolon separated list of strings or js regex patterns.", parseNamespacesOption)
    .option("--context-name <name>")
    .option("--context-base <name>")
    .option("--after-build <script_file>", "JS or TS file with function for calling after build model. Export function as default or with name AfterBuildModel")
    .option("-v --verbose", "Verbose information on errors")
    .arguments("<url_or_path>")
    .arguments("<out_file>")
    .action((a1, a2) => { urlOrPath = a1; outFile = a2 })
    .parse(process.argv) as any as CLI;

var afterBuild;

run()
    .then(() => console.log("Model generated!"),e => error(e, 100))

async function run() {
    if (!urlOrPath)
        error("Error: Metadata url or path to file, required", 1)

    if (!outFile)
        error("Error: Path to output file, required", 1);

    if (fs.existsSync(outFile) && cli.force != true)
        error("Error: Output file already exists. Use force option for overwrite.", 1)

    if (cli.afterBuild)
        if (!fs.existsSync(cli.afterBuild))
            error(`Error: File '${cli.afterBuild}' not found`);
        else
            afterBuild = await getAfterBuildFunc();

    const md =await loadMetadata()
    await generateModel(md);
}

function error(error: string | Error, exitCode?: number) {
    console.error(`\r\n\t${error}\r\n`);
    if (error instanceof Error && cli.verbose)
        console.log(error.stack);
    if (exitCode != undefined)
        process.exit(exitCode);
}

function loadMetadata(): Promise<ApiMetadata> {
    return urlOrPath.endsWith("$metadata")
        ? loadMetadataFromUrl(urlOrPath)
        : loadMetadataFromFile(urlOrPath);
}

function loadMetadataFromUrl(url: string): Promise<ApiMetadata> {
    const apiRoot = url.replace(/\\\$metadata$/, "");
    return ApiMetadata.loadAsync(apiRoot, { fetch });
}

async function loadMetadataFromFile(path: string): Promise<ApiMetadata> {
    if (!fs.existsSync(path))
        error(`Error: File '${path}' not found`, 1);
    try {
        var data: string = await new Promise(
            (resolve, reject) => fs.readFile(path, "utf8", (e, d) => {
                if (e) reject(e);
                resolve(d);
            }));

        var metadata = ApiMetadata.loadFromXml("", data);
        return Promise.resolve(metadata);
    }
    catch (e) {
        error(e.message, 2);
    }
}

function generateModel(metadata: ApiMetadata) {
    var options: GeneratorOptions = {
        imports: cli.imports,
        include: cli.include,
        exclude: cli.exclude,
        apiContextName: cli.contextName,
        apiContextBase: cli.contextBase,
    };
    if (cli.afterBuild)
        options.afterBuildModel = afterBuild;

    return generate(metadata, options)
        .then(code => 
            new Promise((resolve, reject) => {
                fs.writeFile(outFile, code, { encoding: "utf8" }, e => e ? reject(e) : resolve())
            })
        );
}

async function getAfterBuildFunc() {

    const module = await loadScript(
        path.resolve(cli.afterBuild));
    if (module) {
        const func = 
            typeof module == "function" ? module :
            (module.default && typeof module.default == "function") ? module.default :
            (module.afterBuildModel && typeof module.afterBuildModel == "function") ? module.AfterBuildModel :
                    undefined;
        if (func)
            return func
    }
    throw new Error(`Function for afterBuildModel event not found in module: ${cli.afterBuild} `);
}

async function loadScript(filePath: string) {
    if (filePath.endsWith(".ts"))
        return await loadTypeScript(filePath);
    return require(filePath);
}

async function loadTypeScript(filePath: string) {
    const program = createProgram({
        rootNames: [filePath],
        options: {
            module: ModuleKind.CommonJS,
            allowJs: true,
            lib: ["lib.dom.d.ts", "lib.es2017.d.ts"],
            noLib: false,
            inlineSourceMap: true,
            target: ScriptTarget.ES2017
        }
    });
    const resFilePath = filePath.replace(/\\/g, "/");
    const text = await new Promise<string>(resolve => 
        program.emit(
            undefined,
            (fn: string, text: string, w, onErr, sourceFiles) => { if (sourceFiles[0].fileName === resFilePath) resolve(text) }
        ))

    if (processDiagnostic(program, filePath)) {

        var m = new (module as any).constructor();
        m.paths = [path.resolve("node_modules")];
        m.parent = module;
        m._compile(text, filePath);
        return m.exports;
    }
}

function processDiagnostic(program: Program, filePath: string)
{
    const sourceFile = program.getSourceFile(filePath);
    const allDiagnostics = program.getGlobalDiagnostics()
        .concat(program.getOptionsDiagnostics())
        .concat(program.getSyntacticDiagnostics(sourceFile))
        .concat(program.getSemanticDiagnostics(sourceFile))
        .concat(program.getDeclarationDiagnostics(sourceFile));

    let isSuccess = true;
    for (const diagnostic of allDiagnostics) {
        if (diagnostic.file) {
            const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
            const fileName = path.relative(".", diagnostic.file.fileName);

            process.stderr.write(`${fileName}:${pos.line}:${pos.character}\r\n`);
        }

        process.stderr.write(`\t${DiagnosticCategory[diagnostic.category]} TS${diagnostic.code}: ${diagnostic.messageText}\r\n`);
        isSuccess = diagnostic.category != DiagnosticCategory.Error && isSuccess;
    }
    return isSuccess;
}

function parseNamespacesOption(option: string): (string | RegExp)[] {
    return option
        .split(";")
        .map(v => {
            if (v.startsWith("/")) {
                var end = v.lastIndexOf("/");
                var pattern = v.substring(1, end);
                var flags = end == v.length - 1 ? undefined : v.substr(end + 1);
                return RegExp(pattern, flags);
            }
            else
                return v;
        })
}
