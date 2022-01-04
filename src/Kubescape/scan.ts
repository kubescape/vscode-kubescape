import * as vscode from 'vscode'
import { exec } from 'child_process'

import * as install from './install'
import * as logger from '../utils/log'
import { ResourceHighlightsHelperService } from './yamlParse'

let collection : vscode.DiagnosticCollection

type KubescapeReport = { 
    id: number, 
    alert: string, 
    description : string,  
    remediation : string,
    code : string
}

function parseJsonSafe(str : string) {
    let obj

    try {
        obj = JSON.parse(str)
    } catch {
        obj = undefined
        logger.logWarning(`Not valid JSON: ${str}`)
    }

    return obj
}

function addDiagnostic(report : KubescapeReport, range : vscode.Range, status : boolean, collection : vscode.Diagnostic[]) {
    collection.push({
        code: report.code,
        message: `${report.id}:\n${report.alert}\n\n${report.description}\n\n${report.remediation}\n`,
        range: range,
        severity: status ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
        source: 'Kubescape',
    })
}

function processKubescapeResult(res : any) {
    let problems : vscode.Diagnostic[] = []
    if (!collection) {
        collection = vscode.languages.createDiagnosticCollection('kubescape');
    } else {
        collection.clear()
    }
    
    if (vscode.window.activeTextEditor) {

        const doc = vscode.window.activeTextEditor.document
        const currentFileUri = doc.uri

        const lines = doc.getText().split(new RegExp(/\n/))

        for (let ctrlReport of res.controlReports) {
            const has_failed = ctrlReport.failedResources > 0
            const has_warn = ctrlReport.warningResources > 0
            if (has_failed || has_warn) {
                let range: vscode.Range;
                if (ctrlReport.ruleReports) {
                    for (let ruleReport of ctrlReport.ruleReports) {
                        for (let ruleResponse of ruleReport.ruleResponses) {
                            for (let fPath of ruleResponse.failedPaths) {
                                if (fPath === "") continue
                                const steps = ResourceHighlightsHelperService.splitPathToSteps(fPath)
                                let position = ResourceHighlightsHelperService.getStartIndexAcc(steps, lines)

                                if (position.startIndex > 0) {
                                    let start = position.prevIndent
                                    let end = start + steps[steps.length - 1].length
                                    let row = position.startIndex
                                    range = new vscode.Range(new vscode.Position(row, start), 
                                            new vscode.Position(row, end))

                                    let kubescapeReport : KubescapeReport = {
                                        id : ctrlReport.id,
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
                } else {
                    range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1))
                    addDiagnostic(ctrlReport, range, has_failed, problems)
                }
            }
        }
        collection.set(currentFileUri, problems);
    }
}

export async function kubescapeScanYaml(yamlPath : string, framework : string) {
    let cmd = `${install.kubescapeBinaryInfo.location} scan framework ${framework} ${yamlPath} --format json`
    exec(cmd, 
    async (err, stdout, stderr) =>{
        if (err) {
            console.log(stderr)
        } else {
            let res = parseJsonSafe(stdout)
            if (res) {
                processKubescapeResult(res)
            }
        }
    })
}