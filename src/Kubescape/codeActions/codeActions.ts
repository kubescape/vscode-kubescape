import * as vscode from 'vscode';
import { WorkloadControlReport } from '../diagnostics/diagnosticReport/workloadDiagnostics/controlDiagnostics/workloadControlReport';
import { COMMAND_VIEW_CTRL_DOC, KUBESCAPE_DIAGNOSTIC_ID } from '../globals';
import { DiagnosticReportsCollection } from '../diagnostics/diagnosticsReportCollection';
import { create } from 'domain';
import { isYamlFile } from '../../utils/yamlUtils/utils';
import { codeActionMessageDiagnostic, createFix } from './diagnostic/WorkloadControlDiagnostic';
import { Logger } from '../../utils/log';


export class KubescapeCodeActionProvider implements vscode.CodeActionProvider {

    // TODO: Add fixAll,
	public static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.QuickFix
	];

    private createAction(diag: vscode.Diagnostic, document: vscode.TextDocument): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        Logger.debug(`Creating codeaction message diagnostic ${JSON.stringify(diag)}`);
        actions.push(codeActionMessageDiagnostic(diag));
        Logger.debug(`Creating fix with diagnostic ${JSON.stringify(diag)}`);
        // actions.push(createFix(diag, document));
        return actions;
    }

    public provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.CodeAction[] | undefined {
        const codeActions : vscode.CodeAction[] = [];
        context.diagnostics.filter(diag => diag.source === KUBESCAPE_DIAGNOSTIC_ID)
        .forEach(
            (diag) => {
                Logger.debug(`Creating code actions for diagnostic ${JSON.stringify(diag)}`);
                // if(diag.code){
                for(const action of this.createAction(diag, document)){
                    codeActions.push(action);
                }
                // }
            }
        )

        return codeActions;
    }
}