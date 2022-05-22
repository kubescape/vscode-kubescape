import * as vscode from 'vscode'

import { YamlHighlighter } from '@armosec/yamlparse'
import { KubescapeApi } from '@kubescape/install'

import { VscodeUi } from '../utils/ui'
import { Logger } from '../utils/log'
import { ERROR_KUBESCAPE_NOT_INSTALLED } from './globals'
import { KubescapeDiagnostic, KubescapeReport, KubescapeDiagnosticCollections } from './diagnostic'

function handleFailedPaths(framework : any, ctrlReport : any, ruleResponse : any,
    lines : string[], has_failed : boolean, problems : any) {
    for (let fPath of (ruleResponse.failedPaths ? ruleResponse.failedPaths : [])) {
        if (fPath === "") continue
        const steps = YamlHighlighter.splitPathToSteps(fPath)
        let position = YamlHighlighter.getStartIndexAcc(steps, lines)

        if (position.startIndex > 0) {
            let start = position.prevIndent
            let end = start + steps[steps.length - 1].length
            let row = position.startIndex
            const range = new vscode.Range(new vscode.Position(row, start),
                new vscode.Position(row, end))

            let kubescapeReport: KubescapeReport = {
                framework: framework.name,
                id: ctrlReport.id,
                name: ctrlReport.name,
                alert: ruleResponse.alertMessage,
                description: ctrlReport.description,
                remediation: ctrlReport.remediation,
                range : range,
                severity : has_failed ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
                path: fPath,
                fix: undefined
            }
            KubescapeDiagnostic.instance.addReport(kubescapeReport)
        }
    }
}

function handleFixedPaths(framework : any, ctrlReport : any, ruleResponse : any,
    lines : string[], has_failed : boolean, problems : any) {
    for (let fPathObj of (ruleResponse.fixPaths ? ruleResponse.fixPaths : [])) {
        const fPath = fPathObj.path
        const fValue = fPathObj.value
        if (!fPath || fPath === "") continue

        const steps = YamlHighlighter.splitPathToSteps(fPath)
        let position = YamlHighlighter.getStartIndexAcc(steps, lines)

        if (position.startIndex > 0) {
            let start = position.prevIndent
            let end = start + steps[steps.length - 1].length
            let row = position.startIndex
            const range = new vscode.Range(new vscode.Position(row, start),
                new vscode.Position(row, end))

            let kubescapeReport: KubescapeReport = {
                framework: framework.name,
                id: ctrlReport.id,
                name: ctrlReport.name,
                alert: ruleResponse.alertMessage,
                description: ctrlReport.description,
                remediation: ctrlReport.remediation,
                range : range,
                severity : has_failed ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
                path: fPath,
                fix: fValue
            }
            KubescapeDiagnostic.instance.addReport(kubescapeReport)
        }
    }
}

function processKubescapeResult(res : any, filePath : string) {
    const problems = KubescapeDiagnostic.instance
    problems.clear()
    if (!KubescapeDiagnosticCollections[filePath]) {
        KubescapeDiagnosticCollections[filePath] = vscode.languages.createDiagnosticCollection()
        const x = vscode.languages.createDiagnosticCollection()
    } else {
        KubescapeDiagnosticCollections[filePath].clear()
    }
    
    if (vscode.window.activeTextEditor) {

        const doc = vscode.window.activeTextEditor.document
        const currentFileUri = doc.uri

        const lines = doc.getText().split(new RegExp(/\n/))

        for (let framework of res) {
            let frameWorkFailedPaths : boolean = false
            for (let ctrlReport of framework.controlReports) {
                if (problems.has(ctrlReport.id)) continue
                const has_failed = ctrlReport.failedResources > 0
                const has_warn = ctrlReport.warningResources > 0
                if (has_failed || has_warn) {
                    frameWorkFailedPaths = true
                    for (let ruleReport of (ctrlReport.ruleReports ? ctrlReport.ruleReports : [])) {
                        for (let ruleResponse of (ruleReport.ruleResponses ? ruleReport.ruleResponses : [])) {
                            handleFailedPaths(framework, ctrlReport, ruleResponse, lines, has_failed, problems)
                            handleFixedPaths(framework, ctrlReport, ruleResponse, lines, has_failed, problems)
                        }
                    }
                }
            }
            if (!frameWorkFailedPaths) {
                Logger.info(`Framework ${framework.name} has no failed paths to mark`)
            }
        }
        KubescapeDiagnosticCollections[filePath].set(currentFileUri, problems.diagnostics);
    }
}

export function removeFileDiagnostics(filePath : string) {
    if (KubescapeDiagnosticCollections && KubescapeDiagnosticCollections[filePath]) {
        KubescapeDiagnosticCollections[filePath].clear()
        delete KubescapeDiagnosticCollections[filePath]
    }
}

export async function kubescapeScanYaml(document : vscode.TextDocument, displayOutput : boolean = false) : Promise<void> {
    if (!document || document.isUntitled) {
        Logger.error('Scanning only works for real documents', true)
        return
    }

    const yamlPath = document.uri.fsPath
    const kubescapeApi = KubescapeApi.instance

    if (!kubescapeApi.isInstalled) {
        Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true)
        throw new Error
    }

    const scanResults = await kubescapeApi.scanYaml(new VscodeUi, yamlPath)

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

    processKubescapeResult(scanResults, yamlPath)
}