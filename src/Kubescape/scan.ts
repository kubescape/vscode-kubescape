import * as vscode from 'vscode';

import { YamlHighlighter } from '@kubescape/yamlparse';
import { KubescapeApi } from '@kubescape/install';

import { VscodeUi } from '../utils/ui';
import { Logger } from '../utils/log';
import { ERROR_KUBESCAPE_NOT_INSTALLED } from './globals';
import { KubescapeDiagnostic, KubescapeReport, kubescapeDiagnosticCollections } from './diagnostic';

function handlePaths(framework : any, ctrlReport : any, ruleResponse : any, lines : string[], hasFailed : boolean) {
    for (let pathObj of (ruleResponse.paths ? ruleResponse.paths : [])) {
        if (pathObj.failedPath && pathObj.failedPath !== "") {
            handleFailedPaths(framework, ctrlReport, ruleResponse, lines, hasFailed, pathObj.failedPath);
        } else {
            handleFixedPaths(framework, ctrlReport, ruleResponse, lines, hasFailed, pathObj.fixPath);
        }
    }
}

function handleFailedPaths(framework : any, ctrlReport : any, ruleResponse : any, lines : string[], hasFailed : boolean, fPath: any) {
    if (fPath === "") {
        return;
    }

    const steps = YamlHighlighter.splitPathToSteps(fPath);
    let position = YamlHighlighter.getStartIndexAcc(steps, lines);

    if (position.startIndex > 0) {
        let start = position.prevIndent;
        let end = start + steps[steps.length - 1].length;
        let row = position.startIndex;
        const range = new vscode.Range(new vscode.Position(row, start),
            new vscode.Position(row, end));

        let kubescapeReport: KubescapeReport = {
            framework: framework.name,
            id: ctrlReport.controlID,
            name: ctrlReport.name,
            description: ctrlReport.description,
            remediation: ctrlReport.remediation,
            range : range,
            severity : hasFailed ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
            path: fPath,
            fix: undefined
        };
        KubescapeDiagnostic.instance.addReport(kubescapeReport);
    }
    
}

function handleFixedPaths(framework : any, ctrlReport : any, ruleResponse : any, lines : string[], hasFailed : boolean, fixPath: any) {
    const fPath = fixPath.path;
    const fValue = fixPath.value;
    if (!fPath || fPath === "") {
        return;
    }

    const steps = YamlHighlighter.splitPathToSteps(fPath);
    let position = YamlHighlighter.getStartIndexAcc(steps, lines);

    if (position.startIndex > 0) {
        let start = position.prevIndent;
        let end = start + steps[steps.length - 1].length;
        let row = position.startIndex;
        const range = new vscode.Range(new vscode.Position(row, start),
            new vscode.Position(row, end));

        let kubescapeReport: KubescapeReport = {
            framework: framework.name,
            id: ctrlReport.controlID,
            name: ctrlReport.name,
            description: ctrlReport.description,
            remediation: ctrlReport.remediation,
            range : range,
            severity : hasFailed ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
            path: fPath,
            fix: fValue
        };
        KubescapeDiagnostic.instance.addReport(kubescapeReport);
    }
    
}

function processKubescapeResult(res : any, filePath : string) {
    const problems = KubescapeDiagnostic.instance;
    problems.clear();
    if (!kubescapeDiagnosticCollections[filePath]) {
        kubescapeDiagnosticCollections[filePath] = vscode.languages.createDiagnosticCollection();
        const x = vscode.languages.createDiagnosticCollection();
    } else {
        kubescapeDiagnosticCollections[filePath].clear();
    }
    
    if (vscode.window.activeTextEditor) {

        const doc = vscode.window.activeTextEditor.document;
        const currentFileUri = doc.uri;

        const lines = doc.getText().split(new RegExp(/\n/));

        for (let framework of res.summaryDetails.frameworks) {
            let frameWorkFailedPaths : boolean = false;
            for (let ctrlId in framework.controls) {
                let ctrlReport = framework.controls[ctrlId];
                if (problems.has(ctrlId)) {
                    continue;
                }
                const controlSummary = res.summaryDetails.controls[ctrlId];

                const hasFailed = ctrlReport.ResourceCounters.failedResources > 0;
                const hasWarn = ctrlReport.ResourceCounters.excludedResources > 0;
                if (hasFailed || hasWarn) {
                    frameWorkFailedPaths = true;
                    for (let result of res.results) {
                        const ctrlResult = result.controls.find((c: any) => c.controlID === ctrlId);
                        if (!ctrlResult) {
                            continue;
                        }
                        for (let ruleReport of (ctrlResult.rules ? ctrlResult.rules : [])) {
                            handlePaths(framework, controlSummary, ruleReport, lines, hasFailed);
                        }
                    }
                }
            }
            if (!frameWorkFailedPaths) {
                Logger.info(`Framework ${framework.name} has no failed paths to mark`);
            }
        }
        kubescapeDiagnosticCollections[filePath].set(currentFileUri, problems.diagnostics);
    }
}

export function removeFileDiagnostics(filePath : string) {
    if (kubescapeDiagnosticCollections && kubescapeDiagnosticCollections[filePath]) {
        kubescapeDiagnosticCollections[filePath].clear();
        delete kubescapeDiagnosticCollections[filePath];
    }
}

export async function kubescapeScanYaml(document : vscode.TextDocument, displayOutput : boolean = false) : Promise<void> {
    if (!document || document.isUntitled) {
        Logger.error('Scanning only works for real documents', true);
        return;
    }

    const yamlPath = document.uri.fsPath;
    const kubescapeApi = KubescapeApi.instance;

    if (!kubescapeApi.isInstalled) {
        Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true);
        throw new Error;
    }

    const scanResults = await kubescapeApi.scanYaml(new VscodeUi, yamlPath);

    if (displayOutput) {
        // calls back into the provider
        const doc = await vscode.workspace.openTextDocument({
            language: "json", 
            content : JSON.stringify(scanResults, undefined, 2)
        }); 
        await vscode.window.showTextDocument(doc, {
            viewColumn:vscode.ViewColumn.Beside,
            preserveFocus: false, preview: false
        });
    }

    processKubescapeResult(scanResults, yamlPath);
}