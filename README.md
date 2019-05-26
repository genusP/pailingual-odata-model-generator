# Install
 
 ```bash
 npm install --save-dev pailingual-odata-model-generator
 ```

# Options

```bash
cli [options] <url_or_path> <out_file>
```
Arguments are documented below:

## url_or_path
Source of metadata can be represents as file path or web url.

## out_file
Path to file for write generated model.

## Options:

``` 
    -V, --version                output the version number
    -i --imports <imports>       List of import declarations (semicolon separated) to be added to output file
    -f --force                   Overwrite existing output file
    --include <pattern>          Types an operations included to model. Semicolon separated list of strings or js regex patterns.
    --exclude <pattern>          Types an operations not included to model. Semicolon separated list of strings or js regex patterns.
    --context-name <name>        Name of generated api context
    --context-base <name>        Base type of generated api context
    --after-build <script_file>  Script for run after build model
    -v --verbose                 Verbose information on errors
    -h, --help                   output usage information
```
