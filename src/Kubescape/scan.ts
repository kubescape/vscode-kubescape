import * as vscode from 'vscode'
import { exec } from 'child_process'

import * as install from './install'
import { Logger } from '../utils/log'
import { ResourceHighlightsHelperService } from './yamlParse'
import { COMMAND_SCAN_FRAMEWORK, ERROR_KUBESCAPE_NOT_INSTALLED } from './globals'

let collections : any = {}

type KubescapeReport = { 
    framework : string
    id: string, 
    alert: string, 
    description : string,  
    remediation : string,
    code : string
}

function parseJsonSafe(str : string) {
    let obj

    try {
        if (str && str[0] !== '[') {
            str = '[' + str + ']'
        }
        obj = JSON.parse(str)
    } catch {
        obj = undefined
        Logger.warning(`Not valid JSON: ${str}`)
    }

    return obj
}

function getFormattedField(str : string, lable? : string) {
    return str.length > 0 ? `\n${lable}: ${str}\n` : ""
}

function addDiagnostic(report : KubescapeReport, range : vscode.Range, status : boolean, collection : vscode.Diagnostic[]) {
    const heading =`${report.framework} ${report.id}` 
    collection.push({
        code: report.code,
        message: `${heading}\n${'_'.repeat(heading.length)}\n` +
            `${getFormattedField(report.alert, "Alert")}` +
            `${getFormattedField(report.description, "Description")}` +
            `${getFormattedField(report.remediation, "Remediation")}`,
        range: range,
        severity: status ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
        source: 'Kubescape',
    })
}

function processKubescapeResult(res : any, filePath : string) {
    let problems : vscode.Diagnostic[] = []
    if (!collections[filePath]) {
        collections[filePath] = vscode.languages.createDiagnosticCollection();
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
                const has_failed = ctrlReport.failedResources > 0
                const has_warn = ctrlReport.warningResources > 0
                if (has_failed || has_warn) {
                    frameWorkFailedPaths = true
                    let range: vscode.Range;
                    for (let ruleReport of (ctrlReport.ruleReports ? ctrlReport.ruleReports : [])) {
                        for (let ruleResponse of (ruleReport.ruleResponses ? ruleReport.ruleResponses : [])) {
                            for (let fPath of (ruleResponse.failedPaths ? ruleResponse.failedPaths : [])) {
                                if (fPath === "") continue
                                const steps = ResourceHighlightsHelperService.splitPathToSteps(fPath)
                                let position = ResourceHighlightsHelperService.getStartIndexAcc(steps, lines)

                                if (position.startIndex > 0) {
                                    let start = position.prevIndent
                                    let end = start + steps[steps.length - 1].length
                                    let row = position.startIndex
                                    range = new vscode.Range(new vscode.Position(row, start),
                                        new vscode.Position(row, end))

                                    let kubescapeReport: KubescapeReport = {
                                        framework: framework.name,
                                        id: ctrlReport.id,
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
        collections[filePath].set(currentFileUri, problems);
    }
}

export async function kubescapeScanYaml(yamlPath : string, frameworks : string, displayOutput : boolean = false) {
    let kubescapePath : string
    
    if (install.kubescapeBinaryInfo.location.length > 0) {
        kubescapePath = install.kubescapeBinaryInfo.location
    } else if (install.kubescapeBinaryInfo.isInPath) {
        kubescapePath = 'kubescape'
    } else {
        Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true)
        return
    }

    let cmd = `${kubescapePath} ${COMMAND_SCAN_FRAMEWORK} ${frameworks} ${yamlPath} --format json`

    vscode.window.withProgress({
        location: displayOutput ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
        title: "Scanning",
        cancellable: false
    }, () => {
        return new Promise<void>(resolve => {
            exec(cmd,
                async (err, stdout, stderr) => {
                    if (err) {
                        Logger.error(stderr)
                    } else {
                        let res = parseJsonSafe(stdout)
                        if (res) {
                            processKubescapeResult(res, yamlPath)
                        }
                    }

                    if (displayOutput) {
                        const uri = vscode.Uri.parse('untitled:' + "Result");
                        const doc = await vscode.workspace.openTextDocument(uri); // calls back into the provider
                        let editor = await vscode.window.showTextDocument(doc, { preview: false });
                        editor.edit((e) => {
                            e.insert(new vscode.Position(0, 0), stdout)
                        })
                    }

                    resolve()
                })
        })
    })
}