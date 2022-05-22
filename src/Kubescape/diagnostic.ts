import * as vscode from 'vscode'
import { COMMAND_VIEW_CTRL_DOC } from './globals'

export const KUBESCAPE_DIAGNOSTIC_ID = "kubescape"
export const KUBESCAPE_COMMAND = "kubescape"

export type KubescapeReport = { 
    framework : string
    id: string, 
    name : string,
    alert: string, 
    description : string,  
    remediation : string,
    range : vscode.Range,
    severity : vscode.DiagnosticSeverity,
    path : string,
    fix : string | undefined
}

function getFormattedField(str : string, label? : string) {
    return str.length > 0 ? `\n${label}: ${str}\n` : ""
}

export const KubescapeDiagnosticCollections : any = {}

export class KubescapeDiagnostic {
    private _kubescapeFileReports : any
    private static _instance: KubescapeDiagnostic

    constructor() {
        this._kubescapeFileReports = {}
    }

    public static get instance() : KubescapeDiagnostic {
        if (!this._instance) this._instance = new KubescapeDiagnostic
        return this._instance
    }

    private get reportsObj() : any {
        const filename = vscode.window.activeTextEditor?.document.fileName
        if (!filename || !this._kubescapeFileReports) return {}

        if (!this._kubescapeFileReports[filename]) {
            this._kubescapeFileReports[filename] = {}
        }

        return this._kubescapeFileReports[filename]
    }

    public get reports() : KubescapeReport[] {
        return Object.values(this.reportsObj)
    }

    public get reportsIds() : string[] {
        return Object.keys(this.reportsObj)
    }

    public get diagnostics() : vscode.Diagnostic[] {
        return this.reports.map(report => {
            const heading = `${report.name}`

            const message = `${heading}\n${'_'.repeat(heading.length)}\n` +
                `${getFormattedField(report.alert, "Alert")}` +
                `${getFormattedField(report.description, "Description")}` +
                `${getFormattedField(report.remediation, "Remediation")}`

            const diagnostic = new vscode.Diagnostic(report.range, message, report.severity)
            diagnostic.source = KUBESCAPE_DIAGNOSTIC_ID
            diagnostic.code = `${report.id}`

            return diagnostic
        })
    }

    public has(controlId : string) : boolean {
        return this.reportsObj[controlId] != undefined
    }

    public get(controlId : string) : KubescapeReport | undefined {
        return this.reportsObj[controlId]
    }

    public addReport(report : KubescapeReport) {
        this.reportsObj[report.id] = report 
    }

    public clear() {
        const filename = vscode.window.activeTextEditor?.document.fileName
        if (!filename || !this._kubescapeFileReports) return

        this._kubescapeFileReports[filename] = []
    }
}


export class KubescapeCodeAction implements vscode.CodeActionProvider {

	public static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.QuickFix
	]

    private createFix(document: vscode.TextDocument, range: vscode.Range, ctrlReport: KubescapeReport): vscode.CodeAction | undefined {
        const fix = new vscode.CodeAction(`Fix ${ctrlReport.path}`, vscode.CodeActionKind.QuickFix);
        const elementPos = ctrlReport.path.lastIndexOf('.')
        const element =  ctrlReport.path.substring(elementPos + 1)
        const fixStr = `${element}: ${ctrlReport.fix}`
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.replace(document.uri, new vscode.Range(ctrlReport.range.start, ctrlReport.range.end.translate(0, Number.MAX_SAFE_INTEGER)), fixStr);
        return fix
    }

    private createCommand(ctrlReport : KubescapeReport): vscode.CodeAction | undefined {
        const action = new vscode.CodeAction(`View ${ctrlReport.id} documentation`, vscode.CodeActionKind.Empty);

        action.command = { 
            command: COMMAND_VIEW_CTRL_DOC,
            arguments: [ctrlReport.id],
            title: `Learn more about ${ctrlReport.name}`, 
            tooltip: 'This will open the browser with the control documentation' 
        }
        return action
    }

    public provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.CodeAction[] | undefined {
        const codeActions : vscode.CodeAction[] = []
        context.diagnostics.filter(diag => diag.source == KUBESCAPE_DIAGNOSTIC_ID)
        .forEach(diag => {
            if (diag.code) {
                const ctrlReport = KubescapeDiagnostic.instance.get(diag.code.toString())

                if (ctrlReport) {
                    const action = this.createCommand(ctrlReport)
                    if (action) {
                        codeActions.push(action)
                    }
                    if (ctrlReport.fix) {
                        const fix = this.createFix(document, range, ctrlReport)
                        if (fix) {
                            codeActions.push(fix)
                        }
                    }
                }
            }
        })

        return codeActions
    }
}