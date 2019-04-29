#!/usr/bin/env node

import * as commander from "commander";
import * as fs from "fs";
import * as path from "path";
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
}

var urlOrPath: string = null;
var outFile: string = null;
const cli = commander.version("1.0.0.0")
    .option("-i --imports <imports>", "List of import declarations (semicolon separated) to be added to output file", v => v.split(";").filter(_ => _))
    .option("-f --force", "Overwrite existing output file")
    .option("--include <pattern>", "Types an operations included to model. Semicolon separated list of strings or js regex patterns.", parseNamespacesOption)
    .option("--exclude <pattern>", "Types an operations not included to model. Semicolon separated list of strings or js regex patterns.", parseNamespacesOption)
    .option("--context-name <name>")
    .option("--context-base <name>")
    .option("--after-build <script_file>", "Script for run after build model")
    .arguments("<url_or_path>")
    .arguments("<out_file>")
    .action((a1, a2) => { urlOrPath = a1; outFile = a2 })
    .parse(process.argv) as any as CLI;

if (!urlOrPath) 
    error("Metadata url or path to file, required", 1)

if (!outFile)
    error("Path to output file, required", 1);

if (fs.existsSync(outFile) && cli.force != true)
    error("Output file already exists. Use force option for overwrite.", 1)

if (cli.afterBuild && !fs.existsSync(cli.afterBuild))
    error(`File '${cli.afterBuild}' not found`);

loadMetadata()
    .then(generateModel)
    .then(() => console.log("Model builded!"))
    ;

function error(message: string, exitCode?: number) {
    console.error(`\r\n\terror: ${message}\r\n`);
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
        error(`File '${path}' not found`, 1);
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

    let code = generate(metadata, options);
    return new Promise((resolve, reject) => {
        fs.writeFile(outFile, code, { encoding: "utf8" }, e => e ? reject(e) : resolve())
    });
}

function afterBuild(nodes) {
    const module = require(
        path.resolve(cli.afterBuild));
    const func =
        typeof module == "function" ? module :
        (module.default && typeof module.default == "function") ? module.default :
        (module.afterBuildModel && typeof module.afterBuildModel == "function") ? module.AfterBuildModel :
                    undefined;
    if (func)
        func(nodes)
    else
        error(`Function for afterBuildModel event not found in module: ${cli.afterBuild} `);
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
