import * as vscode from 'vscode';
import * as jsdom from 'jsdom';
import fetch from 'node-fetch';

import * as scan from './scan/workloadScan/workloadscan';

import { Logger } from '../utils/log';

export async function scanYaml() {
    const currentFile = vscode.window.activeTextEditor;
    if (!currentFile) {
        Logger.error("Could not locate open directories");
        return;
    }

    if (currentFile.document.languageId !== "yaml") {
        Logger.error("Not an YAML configuration file");
        return;
    }

    scan.kubescapeScanYaml(currentFile.document, true);
}

export async function viewCtrlDoc(params: any[]) {

    const url = `https://hub.armosec.io/docs/${params.toString().replaceAll('.', '-').toLowerCase()}`;


    fetch(url).then(async res => {
        if (res.ok) {
            const content = await res.text();

            const { document } = new jsdom.JSDOM(content).window;

            console.log(document);
            const markdown = document.getElementById('content-container');

            console.log(markdown);
            if (markdown) {

                const markdownContent = markdown.querySelector('.markdown-body');

                if (markdownContent) {

                    const panel = vscode.window.createWebviewPanel(
                        `kubescapeDoc${params}`,
                        `Kubescape Docs ${params}`,
                        vscode.ViewColumn.Beside,
                        {}
    
                    );
    
                    panel.webview.html = markdownContent.innerHTML;
                }
            }
        }
    })
    .catch(err=> {
        Logger.error(err);
        vscode.env.openExternal(vscode.Uri.parse(url));
    });

}