import * as vscode from 'vscode';
import * as fs from 'fs';
import { Logger } from '../../utils/log';
import { DiagnosticReport } from '../../Kubescape/diagnostics/diagnosticReport/diagnosticReport';
import { WorkloadControlReport } from '../../Kubescape/diagnostics/diagnosticReport/workloadDiagnostics/controlDiagnostics/workloadControlReport';
import { DiagnosticReportsCollection } from '../../Kubescape/diagnostics/diagnosticsReportCollection';
import { get } from 'http';

export class KubescapePanelWebviewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'kubescape.KubescapePanel';

    private static _instance: KubescapePanelWebviewProvider | null = null;
    private static _view?: vscode.WebviewView;
    private static _disposables: vscode.Disposable[] = [];
    private static _htmlContent: string = "<h1>Kubescape Panel Initialized.</h1><br> <h1>Open a yaml/dockerfile to see diagnostics.</h1>";
    private static loading: boolean = false;

    private constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    // Singleton instance access
    public static getInstance(extensionUri: vscode.Uri): KubescapePanelWebviewProvider {
        if (!this._instance) {
            this._instance = new KubescapePanelWebviewProvider(extensionUri);
        }
        return this._instance;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        KubescapePanelWebviewProvider._view = webviewView;
        webviewView.webview.options = this.getWebViewOptions(this._extensionUri);
        webviewView.webview.html = KubescapePanelWebviewProvider._htmlContent;

        webviewView.webview.onDidReceiveMessage(
            KubescapePanelWebviewProvider.handleWebviewMessage,
            null,
            KubescapePanelWebviewProvider._disposables
        );
    }

    private getWebViewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
        return {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'media'),
                vscode.Uri.joinPath(extensionUri, 'out/compiled'),
                this._extensionUri
            ]
        };
    }

    // Ensures the webview is initialized, or logs an error
    private static ensureViewInitialized() {
        if (!KubescapePanelWebviewProvider._view) {
            Logger.error('Webview is not initialized yet.');
            return false;
        }
        return true;
    }

    // Update the HTML content with diagnostic report
    public static updateHTMLContentWithDiagnostic(diagnosticReport: DiagnosticReport | undefined) {
        if (!KubescapePanelWebviewProvider.ensureViewInitialized()) {
            return;
        }

        if (!diagnosticReport) {
            KubescapePanelWebviewProvider._htmlContent = fs.readFileSync("./template/error404.html", 'utf-8');
            return;
        }

        const controlReports: WorkloadControlReport[] = diagnosticReport.getControlReports();
        const uniqueControlReports = new Map<string, WorkloadControlReport>();

        for (const controlReport of controlReports) {
            if (!uniqueControlReports.has(controlReport.id)) {
                uniqueControlReports.set(controlReport.id, controlReport);
            }
        }

        let controlReportHTML = "";
        for (const controlReport of uniqueControlReports.values()) {
            controlReportHTML +=
                `<tr>
                    <td>${controlReport.id}</td>
                    <td>${controlReport.name}</td>
                    <td><a href="#" class="line-link" data-line="${controlReport.range.start.line}">${controlReport.range.start.line+1}</a></td>
                </tr>`;
        }

        Logger.debug('Updating HTML Content with Diagnostic Report');
        KubescapePanelWebviewProvider._htmlContent = `
            <table style="border: 1px;">${controlReportHTML}</table>
            <script>
                const vscode = acquireVsCodeApi();
                document.addEventListener('click', (e) => {
                    if (e.target.classList.contains('line-link')) {
                        const line = e.target.getAttribute('data-line');
                        vscode.postMessage({
                            command: 'revealLine',
                            line: parseInt(line)
                        });
                    }
                });
            </script>
        `;
        KubescapePanelWebviewProvider._view!.webview.html = KubescapePanelWebviewProvider._htmlContent;
        KubescapePanelWebviewProvider.loading = false;
    }

    // Handle messages from webview
    private static handleWebviewMessage(message: any) {
        if (message.command === 'revealLine') {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const position = new vscode.Position(message.line, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                Logger.debug(`Revealing line ${message.line}`);
            }
        }
    }

    // Reset HTML content to default
    public static _resetHTMlContent() {
        if (!KubescapePanelWebviewProvider.ensureViewInitialized()) {
            return;
        }
        KubescapePanelWebviewProvider._htmlContent = "<h1>Kubescape Panel Initialized.</h1><br> <h1>Open a yaml/dockerfile to see diagnostics.</h1>";
        KubescapePanelWebviewProvider._view!.webview.html = KubescapePanelWebviewProvider._htmlContent;
        KubescapePanelWebviewProvider.loading = false;
    }

    // Show loading panel
    public static loadingPanel() {
        if (!KubescapePanelWebviewProvider.ensureViewInitialized()) {
            return;
        }
        KubescapePanelWebviewProvider._htmlContent = "<h1>Kubescape scanning in process...</h1>";
        KubescapePanelWebviewProvider._view!.webview.html = KubescapePanelWebviewProvider._htmlContent;
        KubescapePanelWebviewProvider.loading = true;
    }

    // Stop the loading panel
    public static stopLoadingPanel() {
        if (!KubescapePanelWebviewProvider.loading) {
            return;
        }
        Logger.debug('Stopping loading panel');
        KubescapePanelWebviewProvider.loading = false;
        KubescapePanelWebviewProvider._resetHTMlContent();
    }

    public static updateWithCurrentFileDiagnostic() {
        if (!vscode.window.activeTextEditor) {
            return;
        }
        const doc = vscode.window.activeTextEditor.document;
        const diagnosticReport = DiagnosticReportsCollection.instance.get(doc.fileName);
        KubescapePanelWebviewProvider.updateHTMLContentWithDiagnostic(diagnosticReport);
    }
}
