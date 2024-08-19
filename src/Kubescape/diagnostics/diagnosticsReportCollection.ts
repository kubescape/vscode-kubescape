import { DiagnosticReport } from "./diagnosticReport/diagnosticReport";
import * as vscode from 'vscode';
import { Logger } from "../../utils/log";
import { isYamlFile } from "../../utils/yamlUtils/utils";
import { KUBESCAPE_DIAGNOSTIC_ID } from "../globals";

export class DiagnosticReportsCollection {
    private _diagnosticReports: { [key: string]: DiagnosticReport };
    private static _instance: DiagnosticReportsCollection;
    public static vscodeDiagnosticCollection:any;
    
    constructor() {
        this._diagnosticReports = {};
        DiagnosticReportsCollection.vscodeDiagnosticCollection = vscode.languages.createDiagnosticCollection();
    }
    
    public static get instance(): DiagnosticReportsCollection {
        if (!this._instance) {
            this._instance = new DiagnosticReportsCollection();
        }
        return this._instance;
    }

    public get openDiagnosticReport(): DiagnosticReport | undefined {
        const filename = vscode.window.activeTextEditor?.document.fileName;

        if (!filename || !this._diagnosticReports) {
            Logger.error("Could not locate open directories");
        }
        else {
            if(!this._diagnosticReports[filename]) {
                Logger.error("No diagnostic reports found for this file");
            }
            else {
                return this._diagnosticReports[filename];
            }
        }

    }

    public get openVSCodeDiagnosticCollection(): vscode.Diagnostic[] {
        return this.openDiagnosticReport?.diagnosticReport.controlReports?.map((controlReport): vscode.Diagnostic => {
            const diagnostic = new vscode.Diagnostic(controlReport.range, JSON.stringify(controlReport),controlReport.severity)
            diagnostic.source = KUBESCAPE_DIAGNOSTIC_ID;
            return diagnostic;
        }) || [];
    }

    public add(filename: string) {
        // Logger.debug(`Adding diagnostic report for ${filename} and is of type ${isYamlFile(filename)}`);
        this._diagnosticReports[filename] = new DiagnosticReport(isYamlFile(filename), filename);
    }

    public get(fileName: string) {
        return this._diagnosticReports[fileName];
    }

    public set(fileName: string, diagnosticReport: DiagnosticReport) {
        this._diagnosticReports[fileName] = diagnosticReport;
    }

    public removeFileDiagnostics(fileName: string) {
        delete this._diagnosticReports[fileName]
    }

    public addWorkloadControlReport(controlReport: any, ruleReport:any,filename: string,lines: string[], hasFailed: boolean) {
        // Logger.debug(`Diagnostics collection`)
        if(!this._diagnosticReports[filename]){
            this.add(filename);
        }
        this._diagnosticReports[filename].addControlReport(controlReport, ruleReport, lines, hasFailed);
    }

    /* 
    * @param vulnerabilityReport: any: List of CVEs
    * @param filename: string: filename
    * @returns void
    * Adds the workload vulnerabilities to the diagnostic report
     */
    public addWorkloadVulnerabilityReport(vulnerabilityReport: any, filename: string){
        if(!this._diagnosticReports[filename]){
            this.add(filename);
        }
        this._diagnosticReports[filename].addWorkloadVulnerabilityReport(vulnerabilityReport);
    }

    /*
    * @param vulnerabilityReport: any: List of CVEs
    * @param filename: string: filename
    * @returns void
    * Adds the image vulnerabilities to the diagnostic report
    */
    public addImageVulnerabilityReport(vulnerabilityReport: any, filename: string, image: {image: string, line: number}){
        if(!this._diagnosticReports[filename]){
            this.add(filename);
        }
        this._diagnosticReports[filename].addImageVulnerabilityReport(vulnerabilityReport, image);
    }

    public clear() {
        const filename = vscode.window.activeTextEditor?.document.fileName;
        if (!filename || !this._diagnosticReports) {
            return;
        }
        this._diagnosticReports[filename] = new DiagnosticReport(isYamlFile(filename), filename);
    }

}