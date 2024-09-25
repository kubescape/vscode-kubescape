import * as vscode from 'vscode';
import { WorkloadControlReport } from '../diagnostics/diagnosticReport/workloadDiagnostics/controlDiagnostics/workloadControlReport';
import { COMMAND_VIEW_CTRL_DOC, KUBESCAPE_DIAGNOSTIC_ID } from '../globals';
import { DiagnosticReportsCollection } from '../diagnostics/diagnosticsReportCollection';
import { create } from 'domain';
import { isYamlFile } from '../../utils/yamlUtils/utils';
import { createFix } from './diagnostic/WorkloadControlDiagnostic';
import { Logger } from '../../utils/log';


export class KubescapeCodeActionProvider implements vscode.CodeActionProvider {

    // TODO: Add fixAll,
	public static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.QuickFix
	];

    private createAction(diag: vscode.Diagnostic, document: vscode.TextDocument): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        actions.push(createFix(diag, document));
        return actions;
    }

    public provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.CodeAction[] | undefined {
        const codeActions : vscode.CodeAction[] = [];
        context.diagnostics.filter(diag => diag.source === KUBESCAPE_DIAGNOSTIC_ID)
        .forEach(
            (diag) => {
                for(const action of this.createAction(diag, document)){
                    codeActions.push(action);
                }
            }
        )

        return codeActions;
    }
}