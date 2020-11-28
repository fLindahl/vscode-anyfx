'use strict';
import * as cp from 'child_process';
import * as vscode from 'vscode';

const LINT_OK = 0;
const LINT_ERROR = 1;
const LINT_NO_ENTRY_POINT_WARNING = 2;

export default class AnyFXLintProvider implements vscode.CodeActionProvider {
  private static commandId: string = 'anyfx.runCodeAction';
  private command: vscode.Disposable;
  private diagnosticCollection: vscode.DiagnosticCollection;
  private storagePath: string = undefined;
  private textChangeLintQueued: vscode.TextDocument = undefined;
  private textChangeLintInProgress: boolean = false;
  private additionalIncludeDirs: Array<string> = [];

  private extensions: Array<string> = [
    '.fx',
    '.fxh'
  ];

  private includers: { [key: string]: Array<string> } = {};

  private scanFileForIncludes(scanFilePath: string): any {
    let fs = require("fs");
    let readline = require("readline");

    this.includers[scanFilePath] = [];
    let lineReader = readline.createInterface({
      input: fs.createReadStream(scanFilePath)
    });
    lineReader.on('line', line => {
      let matches = line.match(/#include\s*[",<](.*)[",>]/);
      if (matches && matches.length === 2) {
        let filepath = matches[1];
        this.includers[scanFilePath].push(filepath);
      }
    });
  }

  private findAnyFXFiles(callback: (output: Array<string>) => any): any {
    let filePaths: Array<string> = [];

    vscode.workspace.textDocuments.forEach(document => {
      if (document.languageId === "glsl") {
        filePaths.push(document.uri.fsPath);
      }
    });

    let countExpected = this.extensions.length;
    this.extensions.forEach(extension => {
      vscode.workspace.findFiles('**/*' + extension).then(
        files => {
          files.forEach(uri => {
            let filePath = uri.fsPath;
            if (!filePaths.find(thisResult => thisResult === filePath)) {
              filePaths.push(uri.fsPath);
            }
          });
          countExpected--;
          if (countExpected === 0) {
            callback(filePaths);
          }
        },
        notfound => {
          countExpected--;
          if (countExpected === 0) {
            callback(filePaths);
          }
        }
      );
    });
  }

  public activate(subscriptions: vscode.Disposable[], storagePath_: string | undefined) {
    this.storagePath = storagePath_;
    const additionalFileExtensions: Array<string> = vscode.workspace.getConfiguration('anyfx').get('additionalFileExtensions');
    this.extensions.concat(additionalFileExtensions);
    this.extensions = this.extensions.filter((value: string, index: number, array: string[]) => array.indexOf(value) === index);

    // Look for .vscode/anyfx_properties.json and parse the includeDirs
    vscode.workspace.findFiles("**/.vscode/anyfx_properties.json").then((uris) => {
      uris.forEach(uri => {
        const fs = require('fs');
        fs.readFile(uri.fsPath, (err, content) => {
          var data = JSON.parse(content);
          if ('includeDirs' in data) {
            data['includeDirs'].forEach(includeDir => {
              if (!(includeDir in this.additionalIncludeDirs)) {
                this.additionalIncludeDirs.push(includeDir);
              }
            });
          }
        });
      });
    });

    if (this.storagePath) {
      let fs = require("fs");
      fs.mkdir(this.storagePath, { recursive: true }, (err) => {
      });
    }

    let additionalConfiguredExtensions = vscode.workspace.getConfiguration('files.associations');
    Object.keys(additionalConfiguredExtensions).forEach(extension => {
      if (additionalConfiguredExtensions[extension] === "glsl") {
        let extensionOnly = "." + extension.split('.').pop();
        this.extensions.push(extensionOnly);
      }
    });

    this.findAnyFXFiles(files => {
      files.forEach(filePath => {
        this.scanFileForIncludes(filePath);
      });

      vscode.workspace.textDocuments.forEach(this.documentOpened, this);
      this.documentModified(vscode.window.activeTextEditor.document);
    });

    this.command = vscode.commands.registerCommand(AnyFXLintProvider.commandId, this.runCodeAction, this);
    subscriptions.push(this);
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection();

    vscode.workspace.onDidOpenTextDocument(this.documentOpened, this, subscriptions);

    vscode.workspace.onDidCloseTextDocument((textDocument) => {
      this.diagnosticCollection.delete(textDocument.uri);
    }, null, subscriptions);

    vscode.workspace.onDidSaveTextDocument(this.documentSaved, this);
    vscode.workspace.onDidChangeTextDocument(this.documentModifiedEvent, this);

  }

  public dispose(): void {
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
    this.command.dispose();
  }

  private documentOpened(textDocument: vscode.TextDocument): any {
    if (textDocument.languageId === "glsl") {
      this.scanFileForIncludes(textDocument.uri.fsPath);
      this.compileAndLint(textDocument, false, false);
    }
  }

  private documentSaved(textDocument: vscode.TextDocument): any {
    if (textDocument.languageId === "glsl") {
      this.scanFileForIncludes(textDocument.uri.fsPath);
      this.compileAndLint(textDocument, false, true);
    }
  }

  private writeToTmpFileCompileAndLint(textDocument: vscode.TextDocument) {
    this.textChangeLintInProgress = true;
    let tempFilePath = this.storagePath + "/tmpFile." + textDocument.uri.fsPath.split('.').pop();
    let fs = require("fs");
    fs.writeFile(tempFilePath, textDocument.getText(), (err) => {
      const config = vscode.workspace.getConfiguration('anyfx');
      this.compile(tempFilePath, config.additionalIncludes, false, (output) => {
        let inputFilename = tempFilePath.replace(/^.*[\\\/]/, '');
        try {
          this.doLint(textDocument, inputFilename, output);
        }
        catch (err) {
          console.log("linting failed:" + err);
        }
        if (this.textChangeLintQueued) {
          let queuedDocuemnt: vscode.TextDocument = this.textChangeLintQueued;
          this.textChangeLintQueued = undefined;
          this.writeToTmpFileCompileAndLint(queuedDocuemnt);
        }
        else {
          this.textChangeLintInProgress = false;
        }
      });
    });
  }

  private documentModified(textDocument: vscode.TextDocument) {
    if (textDocument) {
      const config = vscode.workspace.getConfiguration('anyfx');
      if (!config.requireSaveToLint) {
        if (textDocument.languageId === "glsl" && this.storagePath) {
          if (this.textChangeLintInProgress) {
            this.textChangeLintQueued = textDocument;
          }
          else {
            this.writeToTmpFileCompileAndLint(textDocument);
          }
        }
      }
    }
  }

  private documentModifiedEvent(changeEvent: vscode.TextDocumentChangeEvent): any {
    this.documentModified(changeEvent.document);
  }

  private compile(inputFilePath: string, additionalIncludeDirs: Array<string>, saveOutput: boolean, callback: (output: string) => any) {
    const config = vscode.workspace.getConfiguration('anyfx');
    if (config.anyfxCompilerPath === null ||
      config.anyfxCompilerPath === '') {
      vscode.window.showErrorMessage(
        'AnyFX: config.anyfxCompilerPath is empty, please set it to the executable');
      return;
    }

    // replace backslash with forwardslash
    inputFilePath = inputFilePath.replace(/\\/g, "/");

    let args = config.anyfxCompilerArgs.split(/\s+/).filter(arg => arg);

    args.push("-i");
    args.push(inputFilePath);

    this.additionalIncludeDirs.forEach(dir => {
      args.push("-I");
      // remove trailing slash and replace backslashes with forward slashes
      let path = dir.replace(/\/$/, "");
      path = path.replace(/\\/g, "/");
      args.push(path);
    });

    if (additionalIncludeDirs) {
      additionalIncludeDirs.forEach(includePath => {
        args.push("-I");
        // remove trailing slash
        const path = includePath.replace(/\/$/, "");
        args.push(path);
      });
    }

    args.push("-q");

    let options = vscode.workspace.rootPath ? { cwd: vscode.workspace.rootPath } :
      undefined;

    let anyfxCompilerOutput = '';

    let childProcess;
    try {
      childProcess = cp.spawn(config.anyfxCompilerPath, args, options);
    } catch (error) {
      console.log(error);
    }
    if (childProcess.pid) {
      childProcess.stderr.on('data', (data) => { anyfxCompilerOutput += data; });
      childProcess.stdout.on('end', () => {
        callback(anyfxCompilerOutput.toString());
      });
    }
  }

  private recursivelyFindIncluders(filename: string, result: Array<string>): any {
    Object.keys(this.includers).forEach(includerFilePath => {
      this.includers[includerFilePath].forEach(included => {
        if (filename.includes(included)) {
          if (!result.find(thisResult => thisResult === includerFilePath)) {
            result.push(includerFilePath);
            this.recursivelyFindIncluders(includerFilePath, result);
          }
        }
      });
    });
  }

  private compileAndLint(textDocument: vscode.TextDocument, saveOutputEvenIfNotConfigured: boolean, saveOutputIfConfigured: boolean) {
    const config = vscode.workspace.getConfiguration('anyfx');
    let saveOutput = saveOutputEvenIfNotConfigured || (saveOutputIfConfigured && config.buildOnSave);
    this.compile(textDocument.fileName, config.additionalIncludes, saveOutput, output => {
      let inputFilename = textDocument.fileName.replace(/^.*[\\\/]/, '');
      let result: number = this.doLint(textDocument, inputFilename, output);
      if (result !== LINT_OK) {
        //vscode.window.showErrorMessage('Compile failed: ' + inputFilename + ' with output: ' + output);
      }
    });
  }

  private doLint(textDocument: vscode.TextDocument, inputFilename: string, compiledOutput: string): number {
    let includedFileWarning = false;

    let diagnostics: vscode.Diagnostic[] = [];
    let lines = compiledOutput.split(/(?:\r\n|\r|\n)/g);
    let foundError = false;

    lines.forEach(line => {
      if (line !== '') {
        let severity: vscode.DiagnosticSeverity = undefined;

        if (line.includes('error:')) {
          severity = vscode.DiagnosticSeverity.Error;
        }
        if (line.includes('warning:')) {
          severity = vscode.DiagnosticSeverity.Warning;
        }

        if (severity !== undefined) {
          let matches = line.match(/(.+)\((\d+)\):\W(error|warning):(.+)/);
          let message = undefined;
          let errorline = 0;
          if (matches) {
            message = matches[4];
            errorline = parseInt(matches[2]);
          }
          else {
            matches = line.match(/(.+): (error|warning):.*:(\d+):.*:\W*(.+)/);
            if (matches) {
              message = matches[4];
              errorline = parseInt(matches[3]);
            }
          }
          if (matches && matches.length === 5) {
            let range = null;

            if (line.includes(inputFilename)) {
              let docLine = textDocument.lineAt(errorline - 1);
              range = new vscode.Range(docLine.lineNumber, docLine.firstNonWhitespaceCharacterIndex, docLine.lineNumber, docLine.range.end.character);
            }
            else {
              let includeFound = false;
              let includeFilename = matches[1].replace(/^.*[\\\/]/, '');
              if (includeFilename) {
                for (let i = 0; i < textDocument.lineCount; i++) {
                  let docLine = textDocument.lineAt(i);
                  if (docLine.text.includes(includeFilename) && docLine.text.includes("#include")) {
                    includeFound = true;
                    range = new vscode.Range(docLine.lineNumber, docLine.firstNonWhitespaceCharacterIndex, docLine.lineNumber, docLine.range.end.character);
                    break;
                  }
                }
              }
              if (!includeFound) {
                let docLine = textDocument.lineAt(0);
                range = new vscode.Range(docLine.lineNumber, docLine.firstNonWhitespaceCharacterIndex, docLine.lineNumber, docLine.range.end.character);
              }
            }

            let diagnostic = new vscode.Diagnostic(range, message, severity);
            diagnostics.push(diagnostic);

            if (severity === vscode.DiagnosticSeverity.Error) {
              foundError = true;
            }
          }
          else {
            let matches = line.match(/.+:\W(error|warning):(.+)/);
            if (matches && matches.length === 3) {
              let message = matches[2];
              let docLine = textDocument.lineAt(0);
              let range = new vscode.Range(docLine.lineNumber, docLine.firstNonWhitespaceCharacterIndex, docLine.lineNumber, docLine.range.end.character);

              let diagnostic = new vscode.Diagnostic(range, message, severity);
              diagnostics.push(diagnostic);

              if (severity === vscode.DiagnosticSeverity.Error) {
                foundError = true;
              }
            }
          }
        }
      }
    });

    this.diagnosticCollection.set(textDocument.uri, diagnostics);

    if (foundError) {
      if (includedFileWarning) {
        return LINT_NO_ENTRY_POINT_WARNING;
      } else {
        return LINT_ERROR;
      }
    }
    return LINT_OK;
  }

  public provideCodeActions(
    document: vscode.TextDocument, range: vscode.Range,
    context: vscode.CodeActionContext, token: vscode.CancellationToken):
    vscode.ProviderResult<vscode.Command[]> {
    throw new Error('Method not implemented.');
  }

  private runCodeAction(
    document: vscode.TextDocument, range: vscode.Range,
    message: string): any {
    throw new Error('Method not implemented.');
  }
}