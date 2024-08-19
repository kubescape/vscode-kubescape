import * as vscode from 'vscode';
import { KubescapeApi } from '@kubescape/install';
import { VscodeUi } from '../../utils/ui';
import { Logger } from '../../utils/log';
import { kubescapeScanYaml } from './workloadScan/workloadscan';
import { kubescapeImageScan } from './imageScan/imageScan';
import { ERROR_KUBESCAPE_NOT_INSTALLED } from '../globals';
import { DiagnosticReportsCollection } from '../diagnostics/diagnosticsReportCollection';
import { KubescapePanelWebviewProvider } from '../../ui/kubescapePanel/kubescapePanel';

export async function kubescapeScanDocument(document: vscode.TextDocument, displayOutput: boolean = false): Promise<void> {
    if (!document || document.isUntitled) {
        Logger.error('Scanning only works for real documents', true);
        return;
    }

    let scanCompleted: boolean = false;
    const problem = DiagnosticReportsCollection.instance;
    try{
        const kubescapeApi = KubescapeApi.instance;
        KubescapePanelWebviewProvider.loadingPanel();
        if (!kubescapeApi.isInstalled) {
            Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED, true);
            throw new Error();
        }

        problem.clear();
        const lines = document.getText().split(new RegExp(/\n/));
        if (document.languageId === "yaml") {
            kubescapeScanYaml(document, displayOutput,lines).then(
                ()=>{
                    DiagnosticReportsCollection.vscodeDiagnosticCollection.set(document.uri, problem.getVSDiagnostics(document.fileName));
                }
            );
        }
        kubescapeImageScan(document,lines).then(
            ()=>{
                DiagnosticReportsCollection.vscodeDiagnosticCollection.set(document.uri, problem.getVSDiagnostics(document.fileName));
            }
        );
        scanCompleted = true;

    }catch(err: any){
        Logger.error(err.message, true);
        // Update panel with Error message. Some error occured while scanning
        
    } finally {
        if(scanCompleted){
            KubescapePanelWebviewProvider.updateHTMLContentWithDiagnostic(problem.get(document.fileName));
        }
        KubescapePanelWebviewProvider.stopLoadingPanel();
        // stop loaders if any. make sure no other parallel scans are running
    }
    
}