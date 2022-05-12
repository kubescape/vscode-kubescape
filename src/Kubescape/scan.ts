import * as vscode from 'vscode'

import { YamlHighlighter } from '@armosec/yamlparse'
import { KubescapeApi } from '@kubescape/install'

import { VscodeUi } from '../utils/ui'
import { Logger } from '../utils/log'
import { ERROR_KUBESCAPE_NOT_INSTALLED } from './globals'

let collections : any = {}

type KubescapeReport = { 
    framework : string
    id: string, 
    name : string,
    alert: string, 
    description : string,  
    remediation : string,
    code : string
}

function getFormattedField(str : string, label? : string) {
    return str.length > 0 ? `\n${label}: ${str}\n` : ""
}

function addDiagnostic(report : KubescapeReport, range : vscode.Range, status : boolean, collection : any) {
    if (collection && !collection[report.id]) {
        const heading =`${report.name}` 
        collection[report.id] = {
            code: report.code,
            message: `${heading}\n${'_'.repeat(heading.length)}\n` +
                `${getFormattedField(report.alert, "Alert")}` +
                `${getFormattedField(report.description, "Description")}` +
                `${getFormattedField(report.remediation, "Remediation")}`,
            range: range,
            severity: status ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
            source: `https://hub.armo.cloud/docs/${report.id}`,
        }
    }
}

function processKubescapeResult(res : any, filePath : string) {
    let problems : any = {}
    if (!collections[filePath]) {
        collections[filePath] = vscode.languages.createDiagnosticCollection()
    } else {
        collections[filePath].clear()
    }
    
    if (vscode.window.activeTextEditor) {

        const doc = vscode.window.activeTextEditor.document
        const currentFileUri = doc.uri

        const lines = doc.getText().split(new RegExp(/\n/))

        for (let framework of res) {
            let frameWorkFailedPaths : boolean = false
            for (let ctrlReport of framework.controlReports) {
                if (problems && problems[ctrlReport.id]) continue
                const has_failed = ctrlReport.failedResources > 0
                const has_warn = ctrlReport.warningResources > 0
                if (has_failed || has_warn) {
                    frameWorkFailedPaths = true
                    let range: vscode.Range;
                    for (let ruleReport of (ctrlReport.ruleReports ? ctrlReport.ruleReports : [])) {
                        for (let ruleResponse of (ruleReport.ruleResponses ? ruleReport.ruleResponses : [])) {
                            for (let fPath of (ruleResponse.failedPaths ? ruleResponse.failedPaths : [])) {
                                if (fPath === "") continue
                                const steps = YamlHighlighter.splitPathToSteps(fPath)
                                let position = YamlHighlighter.getStartIndexAcc(steps, lines)

                                if (position.startIndex > 0) {
                                    let start = position.prevIndent
                                    let end = start + steps[steps.length - 1].length
                                    let row = position.startIndex
                                    range = new vscode.Range(new vscode.Position(row, start),
                                        new vscode.Position(row, end))

                                    let kubescapeReport: KubescapeReport = {
                                        framework: framework.name,
                                        id: ctrlReport.id,
                                        name : ctrlReport.name,
                                        alert: ruleResponse.alertMessage,
                                        description: ctrlReport.description,
                                        remediation: ctrlReport.remediation,
                                        code: fPath
                                    }
                                    addDiagnostic(kubescapeReport, range, has_failed, problems)
                                }
                            }
                        }
                    }
                }
            }
            if (!frameWorkFailedPaths) {
                Logger.info(`Framework ${framework.name} has no failed paths to mark`)
            }
        }
        collections[filePath].set(currentFileUri, Object.keys(problems).map(problemId => problems[problemId]));
    }
}

export function removeFileDiagnostics(filePath : string) {
    if (collections && collections[filePath]) {
        collections[filePath].clear()
        delete collections[filePath]
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