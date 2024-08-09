import * as vscode from 'vscode';
import { COMMAND_VIEW_CTRL_DOC } from './globals';

export const KUBESCAPE_DIAGNOSTIC_ID = "kubescape";
export const KUBESCAPE_COMMAND = "kubescape";

export type KubescapeReport = { 
    framework : string
    id: string, 
    name : string,
    description : string,  
    remediation : string,
    range : vscode.Range,
    severity : vscode.DiagnosticSeverity,
    path : string[] | null,
    fix : string | null
};

function getFormattedField(str : string, label? : string) {
    return str.length > 0 ? `\n${label}: ${str}\n` : "";
}

export const kubescapeDiagnosticCollections : any = {};

export class KubescapeDiagnostic {
    private _kubescapeFileReports : any;
    private static _instance: KubescapeDiagnostic;

    constructor() {
        this._kubescapeFileReports = {};
    }

    public static get instance() : KubescapeDiagnostic {
        if (!this._instance) {
            this._instance = new KubescapeDiagnostic;
        }
        return this._instance;
    }

    private get reportsObj() : any {
        const filename = vscode.window.activeTextEditor?.document.fileName;
        if (!filename || !this._kubescapeFileReports) {
            return {};
        }

        if (!this._kubescapeFileReports[filename]) {
            this._kubescapeFileReports[filename] = {};
        }

        return this._kubescapeFileReports[filename];
    }

    public get reports() : KubescapeReport[] {
        return Object.values(this.reportsObj);
    }

    public get reportsIds() : string[] {
        return Object.keys(this.reportsObj);
    }

    public get diagnostics() : vscode.Diagnostic[] {
        return this.reports.map(report => {
            const heading = `${report.name}`;

            const message = `${heading}\n${'_'.repeat(heading.length)}\n` +
                `${getFormattedField(report.description, "Description")}` +
                `${getFormattedField(report.remediation, "Remediation")}`;

            const diagnostic = new vscode.Diagnostic(report.range, message, report.severity);
            diagnostic.source = KUBESCAPE_DIAGNOSTIC_ID;
            diagnostic.code = `${report.id}`;

            return diagnostic;
        });
    }

    public has(controlId : string) : boolean {
        return this.reportsObj[controlId] != undefined;
    }

    public get(controlId : string) : KubescapeReport | undefined {
        return this.reportsObj[controlId];
    }

    public addReport(report : KubescapeReport) {
        this.reportsObj[report.id] = report; 
    }

    public clear() {
        const filename = vscode.window.activeTextEditor?.document.fileName;
        if (!filename || !this._kubescapeFileReports) {
            return;
        }
        this._kubescapeFileReports[filename] = [];
    }
}


export class KubescapeCodeAction implements vscode.CodeActionProvider {

    // TODO: Add fixAll,
	public static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.QuickFix
	];

    private createFix(document: vscode.TextDocument, range: vscode.Range, ctrlReport: KubescapeReport): vscode.CodeAction | undefined {
        let strPath: string = ctrlReport.path? ctrlReport.path.reduce((acc, curr) => `${acc}.${curr}`):"";
        const fix = new vscode.CodeAction(`Set ${strPath} to value : ${ctrlReport.fix}`, vscode.CodeActionKind.QuickFix);
        const lines = document.getText().split(new RegExp(/\n/));
        let regExpForArray: RegExp = new RegExp(/\[\d+]/);
        fix.edit = new vscode.WorkspaceEdit();
        const fixStr = ctrlReport.fix;
        const fixPathSteps: string[] = ctrlReport.path || [];
        const nonWhiteSpaceChar: RegExp = new RegExp(/[^\s+]/)
        if(fixPathSteps.length > 0) {
            let insertString = "";
            let firstStartIndex: number | null = null;
            let currentLineIndex: number = range.start.line;
            let noOfLines: number = lines.length;
            while(firstStartIndex === null && currentLineIndex<noOfLines) {
                firstStartIndex = lines[currentLineIndex].search(nonWhiteSpaceChar);
                currentLineIndex++;
            }
            let spaceStr: string = "";
            if(firstStartIndex === null) {
                firstStartIndex = ctrlReport.range.start.character+2;
            }
            for(let i = 0; i<firstStartIndex; i++) {
                spaceStr += " ";
            }
            while(fixPathSteps.length > 0) {
                let step = fixPathSteps.shift();
                if(step && regExpForArray.test(step)) {
                    step = step.replace(regExpForArray, '');
                    step = "- "+step;
                }
                if(step) {
                    insertString += `\n${spaceStr}${step}:`;
                }
                spaceStr += "  ";
            }
            insertString += ` ${fixStr}`
            fix.edit.insert(document.uri, ctrlReport.range.end.translate(0, Number.MAX_SAFE_INTEGER), fixStr? insertString : "");
        }
        else{
            fix.edit.replace(document.uri, new vscode.Range(new vscode.Position(ctrlReport.range.start.line,lines[ctrlReport.range.start.line].search(":")) , ctrlReport.range.end.translate(0, Number.MAX_SAFE_INTEGER)), fixStr? fixStr : "");
        }

        return fix;
    }

    private createCommand(ctrlReport : KubescapeReport): vscode.CodeAction | undefined {
        const action = new vscode.CodeAction(`View ${ctrlReport.id} documentation`, vscode.CodeActionKind.Empty);

        action.command = { 
            command: COMMAND_VIEW_CTRL_DOC,
            arguments: [ctrlReport.id],
            title: `Learn more about ${ctrlReport.name}`, 
            tooltip: 'This will open the browser with the control documentation' 
        };
        return action;
    }

    public provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.CodeAction[] | undefined {
        const codeActions : vscode.CodeAction[] = [];
        context.diagnostics.filter(diag => diag.source === KUBESCAPE_DIAGNOSTIC_ID)
        .forEach(diag => {
            if (diag.code) {
                const ctrlReport = KubescapeDiagnostic.instance.get(diag.code.toString());

                if (ctrlReport) {
                    const action = this.createCommand(ctrlReport);
                    if (action) {
                        codeActions.push(action);
                    }
                    if (ctrlReport.fix) {
                        const fix = this.createFix(document, range, ctrlReport);
                        if (fix) {
                            codeActions.push(fix);
                        }
                    }
                }
            }
        });

        return codeActions;
    }
}