# AnyFX linting and syntax highlighting for Visual Studio Code

Adds linting and syntax highlighting for [AnyFX](https://github.com/duttenheim/fips-anyfx) files to Visual Studio Code.

## Setup
Make sure you set the `anyfx.anyfxCompilerPath` setting to a valid compiler.

### Settings
- `anyfx.anyfxCompilerPath`: The path to the anyfx compiler executable  
- `anyfx.anyfxCompilerArgs`: Additional arguments for the anyfx compiler executable
- `anyfx.additionalIncludes`: Additional include directories when compiling and linting shaders
- `anyfx.requireSaveToLint`: By default, linting will occur with every text change. Enable this option to only lint when you save the file.
- `anyfx.additionalFileExtensions`: Additional file extensions which should be considered as AnyFX files.

### TODO
* Symbols support!

---

## Thanks to:
* Duttenheim - https://github.com/duttenheim

* mjdave (vscode-shaderc) - https://github.com/mjdave/vscode-shaderc
    - Used as reference, inspiration and as starting point for this project. See [attributions.txt](attributions.txt).