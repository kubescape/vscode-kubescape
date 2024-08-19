import * as vscode from 'vscode';
import { KubescapeApi } from '@kubescape/install';
import { VscodeUi } from '../../utils/ui';
import { Logger } from '../../utils/log';
import { kubescapeScanYaml } from './workloadScan/workloadscan';
import { kubescapeImageScan } from './imageScan/imageScan';
import { ERROR_KUBESCAPE_NOT_INSTALLED } from '../globals';
import { DiagnosticReportsCollection } from '../diagnostics/diagnosticsReportCollection';

// export async function kubescapeScanDocument(document : vscode.TextDocument, displayOutput : boolean = false) : Promise<void> {
//     if (!document || document.isUntitled) {
//         Logger.error('Scanning only works for real documents', true);
//         return;
//     }

//     const filePath = document.uri.fsPath;
//     const kubescapeApi = KubescapeApi.instance;

//     if (!kubescapeApi.isInstalled) {
//         Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true);
//         throw new Error;
//     }

//     const problem = DiagnosticReportsCollection.instance;
//     problem.clear();

//     // for now processsing of scan results is included in the scan functions, but this can be moved to a separate function. allows modularity, to change according to need
//     if(document.languageId === "yaml") {
//         await kubescapeScanYaml(document, displayOutput);
//     }

//     await kubescapeImageScan(document);
//     Logger.debug(`Added image scan for ${filePath}`);
//     Logger.debug(`Diagnostic reports: ${JSON.stringify(problem.get(document.fileName))}`);
// }

export async function kubescapeScanDocument(document: vscode.TextDocument, displayOutput: boolean = false): Promise<void> {
    if (!document || document.isUntitled) {
        Logger.error('Scanning only works for real documents', true);
        return;
    }

    const filePath = document.uri.fsPath;
    const kubescapeApi = KubescapeApi.instance;
    if (!kubescapeApi.isInstalled) {
        Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true);
        throw new Error();
    }

    const problem = DiagnosticReportsCollection.instance;
    problem.clear();

    // Run YAML scan if applicable
    if (document.languageId === "yaml") {
        await kubescapeScanYaml(document, displayOutput);
    }

    // Run image scan
    await kubescapeImageScan(document);

    // Log debug messages after both scans have completed
    Logger.debug(`Added image scan for ${filePath}`);
    // Logger.debug(`Diagnostic reports: ${JSON.stringify(problem.get(document.fileName))}`);
}