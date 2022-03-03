import * as vscode from 'vscode'
import { exec } from 'child_process'
import { AbortController } from 'abort-controller'

import * as ui from '../utils/ui'
import { Logger } from '../utils/log'
import { ResourceHighlightsHelperService } from './yamlParse'
import { COMMAND_SCAN_FRAMEWORK, ERROR_KUBESCAPE_NOT_INSTALLED } from './globals'
import { KubescapeBinaryInfo } from './info'
import '../utils/extensionMethods'

let collections : any = {}

type KubescapeReport = { 
    framework : string
    id: string, 
    alert: string, 
    description : string,  
    remediation : string,
    code : string
}

function getFormattedField(str : string, lable? : string) {
    return str.length > 0 ? `\n${lable}: ${str}\n` : ""
}

function addDiagnostic(report : KubescapeReport, range : vscode.Range, status : boolean, collection : any) {
    const heading =`${report.framework} ${report.id}` 
    if (collection && !collection[report.id]) {
        collection[report.id] = {
            code: report.code,
            message: `${heading}\n${'_'.repeat(heading.length)}\n` +
                `${getFormattedField(report.alert, "Alert")}` +
                `${getFormattedField(report.description, "Description")}` +
                `${getFormattedField(report.remediation, "Remediation")}`,
            range: range,
            severity: status ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
            source: 'Kubescape',
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
    if (!document || document.isUntitled) return

    const yamlPath = document.uri.fsPath
    const kubescapeBinaryInfo : KubescapeBinaryInfo = KubescapeBinaryInfo.instance

    if (!kubescapeBinaryInfo.isInstalled) {
        Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true)
        throw new Error
    }

    const useArtifactsFrom = `--use-artifacts-from "${kubescapeBinaryInfo.frameworkDirectory}"`
    const scanFrameworks = kubescapeBinaryInfo.frameworksNames.join(",")

    const cmd = `${kubescapeBinaryInfo.path} ${COMMAND_SCAN_FRAMEWORK} ${useArtifactsFrom} ${scanFrameworks} ${yamlPath} --format json`

    const cancel = new AbortController
    const scanResults = await ui.progress("Kubescape scanning", cancel, !displayOutput, async () => {
        return new Promise<any>(resolve => {
            exec(cmd,
                async (err, stdout, stderr) => {
                    if (err) {
                        Logger.error(stderr)
                        resolve({})
                        return
                    }

                    const res = stdout.toJsonArray()
                    if (!res) {
                        resolve({})
                        return
                    }

                    if (displayOutput) {
                        // calls back into the provider
                        const doc = await vscode.workspace.openTextDocument({
                            language: "json", 
                            content : JSON.stringify(res, undefined, 2)
                        }); 
                        await vscode.window.showTextDocument(doc, {
                            viewColumn:vscode.ViewColumn.Beside, 
                            preserveFocus: false, preview: false 
                        });
                    }

                    resolve(res)
                })
        })
    })

    processKubescapeResult(scanResults, yamlPath)
}