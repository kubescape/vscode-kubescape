import * as vscode from 'vscode';
import { COMMAND_VIEW_CTRL_DOC } from '../../globals';
import { KUBESCAPE_DIAGNOSTIC_ID, KUBESCAPE_COMMAND } from '../../globals';
import { WorkloadControlReport } from './workloadDiagnostics/controlDiagnostics/workloadControlReport';
import { ImageVulnerabilityReport } from './imageScanDiagnostics/imageVulnerabilityReport/imageVulnerabilityReport';
import { Logger } from '../../../utils/log';
import { WorkloadVulnerabilityReport } from './workloadDiagnostics/vulnerabilityDiagnostics/workloadVulnerabilityReport';

export class DiagnosticReport {

    diagnosticReport: {
        controlReports: WorkloadControlReport[] | null,
        imageVulnerabilityReports: {
            // [key: {image: string, line: number}]: ImageVulnerabilityReport[]
            image: string,
            line: number,
            vulnerabilities: ImageVulnerabilityReport[]
        }[],
        workloadVulnerabilityReports: WorkloadVulnerabilityReport[] | null
    }
    fileName: string;
    
    constructor(isYaml: boolean = false, fileName: string) {
        if (!
            isYaml) {
            this.diagnosticReport = {
                controlReports: null,
                imageVulnerabilityReports: [],
                workloadVulnerabilityReports: null
            }
        }
        else {
            this.diagnosticReport = {
                controlReports: [],
                imageVulnerabilityReports: [],
                workloadVulnerabilityReports: []
            }
        }
        this.fileName = fileName;
    }

    public addControlReport(controlReport: any,ruleReport:any, lines: string[], hasFailed: boolean) {
        if(ruleReport.paths === undefined || ruleReport.paths.length === 0){
            ruleReport.paths = [];
        }
        for(let path of ruleReport.paths){
            // check if diagnostic report already present
            let found = false;
            if(this.diagnosticReport.controlReports){
                for(let report of this.diagnosticReport.controlReports){
                    if(report.id === controlReport.controlID && report.path === path){
                        found = true;
                        break;
                    }
                }
            }
            if(found){
                continue;
            }
            this.diagnosticReport.controlReports?.push(new WorkloadControlReport(controlReport, path, lines, hasFailed));
        }
    }

    public addImageVulnerabilityReport(imageVulnerabilityReports: any, image: {image: string, line: number}) {
        const newImageReport: {
            image: string,
            line: number,
            vulnerabilities: ImageVulnerabilityReport[]
        } = {
            image: image.image,
            line: image.line,
            vulnerabilities: []
        };
        for(const vulnerability of imageVulnerabilityReports.matches){
            if(vulnerability.vulnerability.severity === "Critical" || vulnerability.vulnerability.severity === "High") {
                newImageReport.vulnerabilities.push(new ImageVulnerabilityReport(vulnerability));
            }
        }
        this.diagnosticReport.imageVulnerabilityReports?.push(newImageReport);
    }

    public addWorkloadVulnerabilityReport(workloadVulnerabilityReport: any) {
        this.diagnosticReport.workloadVulnerabilityReports?.push(new WorkloadVulnerabilityReport(workloadVulnerabilityReport));
    }

    public getControlReports(): WorkloadControlReport[] {
        return this.diagnosticReport.controlReports? this.diagnosticReport.controlReports : [];
    }
    
    public getImageVulnerabilityReports() {
        return this.diagnosticReport.imageVulnerabilityReports? this.diagnosticReport.imageVulnerabilityReports : [];
    }

    public getWorkloadVulnerabilityReports() {
        return this.diagnosticReport.workloadVulnerabilityReports? this.diagnosticReport.workloadVulnerabilityReports : [];
    }

    public get diagnostics(): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        if(this.diagnosticReport.controlReports) {
            this.diagnosticReport.controlReports.forEach((report: any) => {
                const diagnostic = new vscode.Diagnostic(report.range, report.description, report.severity);
                diagnostic.source = KUBESCAPE_DIAGNOSTIC_ID;
                diagnostic.code = report.id;
                diagnostics.push(diagnostic);
            });
        }
        if(this.diagnosticReport.imageVulnerabilityReports) {
            this.diagnosticReport.imageVulnerabilityReports.forEach((report: any) => {
                const diagnostic = new vscode.Diagnostic(report.range, report.description, report.severity);
                diagnostic.source = KUBESCAPE_DIAGNOSTIC_ID;
                diagnostic.code = report.id;
                diagnostics.push(diagnostic);
            });
        }
        if(this.diagnosticReport.workloadVulnerabilityReports) {
            this.diagnosticReport.workloadVulnerabilityReports.forEach((report: any) => {
                const diagnostic = new vscode.Diagnostic(report.range, report.description, report.severity);
                diagnostic.source = KUBESCAPE_DIAGNOSTIC_ID;
                diagnostic.code = report.id;
                diagnostics.push(diagnostic);
            });
        }
        return diagnostics;
    }

    public clear() {
        if(this.diagnosticReport.controlReports) {
            this.diagnosticReport.controlReports = [];
        }
        if(this.diagnosticReport.imageVulnerabilityReports) {
            this.diagnosticReport.imageVulnerabilityReports = [];
        }
        if(this.diagnosticReport.workloadVulnerabilityReports) {
            this.diagnosticReport.workloadVulnerabilityReports = [];
        }
    }

}