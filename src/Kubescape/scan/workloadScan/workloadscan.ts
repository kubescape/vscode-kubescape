import * as vscode from 'vscode';
import { KubescapeApi } from '@kubescape/install';

import { VscodeUi } from '../../../utils/ui';
import { Logger } from '../../../utils/log';
import { ERROR_KUBESCAPE_NOT_INSTALLED } from '../../globals';
import path = require('path');
import { DiagnosticReportsCollection } from '../../diagnostics/diagnosticsReportCollection';

export async function kubescapeScanYaml(document : vscode.TextDocument, displayOutput : boolean, lines: string[]) : Promise<void> {
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
    const scanResults = await kubescapeApi.scanYaml(new VscodeUi, yamlPath); // change this to workload scan and security scan feature only: make it kind of a option thing.

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

    processWorkloadScan(scanResults, document, lines);
}

function processWorkloadScan(scanResults: any, document: vscode.TextDocument, lines: string[]) {
    const problem = DiagnosticReportsCollection.instance;

    if(problem.get(document.fileName)){
        problem.get(document.fileName).clear();
    }
    else {
        const x = vscode.languages.createDiagnosticCollection();
        problem.add(document.fileName);
    }

    // For now we are adding the code to process the workload scan, but its better to include this in a seperate module/folder and to also add functions to process each type of report from there, and then pass it to add for easier modification of code
    for (let framework of scanResults.summaryDetails.frameworks) {
        let frameworkFailedPaths : boolean = false;
        for(const [ctrlID, ctrlReport] of Object.entries(framework.controls)){
            const hasFailed = (ctrlReport as any).ResourceCounters.failedResources > 0;
            const hasWarn = (ctrlReport as any).ResourceCounters.excludedResources > 0;
            if(hasFailed || hasWarn) {
                frameworkFailedPaths = true;
                for(let result of scanResults.results){
                    const ctrlResult = result.controls.find((c: any) => c.controlID === ctrlID);
                    if(!ctrlResult){
                        continue;
                    }
                    for(let ruleReport of (ctrlResult.rules ? ctrlResult.rules : [])){
                        problem.addWorkloadControlReport(scanResults.summaryDetails.controls[ctrlID], ruleReport, document.fileName, lines, hasFailed);
                    }
                }
            }
        }
        if(!frameworkFailedPaths){
            Logger.info(`Framework ${framework.name} has no failed paths to mark`);
        }
    }
    for(let vulnerability of scanResults.summaryDetails.vulnerabilities.CVEs){
        problem.addWorkloadVulnerabilityReport(vulnerability, document.fileName);
    }
}
