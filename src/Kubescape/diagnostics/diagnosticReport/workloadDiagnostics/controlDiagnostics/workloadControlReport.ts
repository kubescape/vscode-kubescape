import * as vscode from 'vscode';
import { YamlParse } from '../../../../../utils/yamlUtils/yamlHandler/yamlParse';
import { Logger } from '../../../../../utils/log';

export class WorkloadControlReport {
    public id: string;
    public name: string;
    public description: string;
    public remediation: string;
    public path: string;
    public range: vscode.Range;
    public severity: vscode.DiagnosticSeverity;
    public fixSteps: string[] | null;
    public fix: string | undefined;

    constructor(controlReport: any, path:any, lines: string[],hasFailed: boolean) {
        this.id = controlReport.controlID
        this.name = controlReport.name;
        this.description = controlReport.description;
        this.remediation = controlReport.remediation;
        this.path = path.failedPath;
        this.fix = undefined;
        if(this.path === "" || this.path === undefined){
            this.path = path.reviewPath;
        }
        if(this.path === "" || this.path === undefined){
            this.path = path.fixPath.path;
            this.fix = path.fixPath.value;
        }
        if(this.path === "" || this.path === undefined){
            this.path = "";
        }
        const temp = YamlParse.getRangeFromPathWithFixSteps(this.path, lines);
        this.fixSteps = temp.fixSteps;
        this.range = new vscode.Range(new vscode.Position(temp.startRowIndex, temp.startIndex), new vscode.Position(temp.endRowIndex, temp.endIndex));
        this.severity = hasFailed ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
    }
    
}