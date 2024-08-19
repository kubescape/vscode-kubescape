import * as vscode from 'vscode';
import { KUBESCAPE_COMMAND } from '../../globals';
import { Logger } from '../../../utils/log';

export function codeActionMessageDiagnostic(diagnostic : vscode.Diagnostic) : vscode.CodeAction {
    const action = new vscode.CodeAction(`View ${diagnostic.message} documentation`, vscode.CodeActionKind.Empty);
    const vari = JSON.parse(diagnostic.message);
    action.command = {
        command: KUBESCAPE_COMMAND,
        arguments: [vari.id],
        title: `Learn more about ${vari.id}`,
        tooltip: 'This will open the browser with the control documentation'
    };
    return action;
}

export function createFix(diagnostic: vscode.Diagnostic, document: vscode.TextDocument): vscode.CodeAction {
    const vari = JSON.parse(diagnostic.message);
    const range = diagnostic.range;
    const ctrlReport = vari;
    let strPath: string = ctrlReport.path? ctrlReport.path:"";
    let regExpForArray: RegExp = new RegExp(/\[\d+]/);
    let lines: string[] = [];
    Logger.debug(`Fixing ${JSON.stringify(ctrlReport)}`);
    try{
        lines = document.getText().split("\n");
    }catch(e){
        Logger.error(`Error in creating fix: ${e}`);
    }
    
    const fix = new vscode.CodeAction(`Set ${strPath} to value : ${ctrlReport.fix}`, vscode.CodeActionKind.QuickFix);
    fix.edit = new vscode.WorkspaceEdit();
    const fixStr = ctrlReport.fix;
    const fixPathSteps: string[] = ctrlReport.fixSteps || [];
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
        else {
            for(let i = 0; i<firstStartIndex; i++) {
                spaceStr += " ";
            }
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
        if (document) {
            fix.edit.insert(document.uri, ctrlReport.range.end.translate(0, Number.MAX_SAFE_INTEGER), fixStr ? insertString : "");
        }
    }
    else{
        if(document) {
           fix.edit.replace(document.uri, new vscode.Range(new vscode.Position(ctrlReport.range.start.line,lines[ctrlReport.range.start.line].search(":")) , ctrlReport.range.end.translate(0, Number.MAX_SAFE_INTEGER)), fixStr? fixStr : "");
        }
    }

    return fix;
}