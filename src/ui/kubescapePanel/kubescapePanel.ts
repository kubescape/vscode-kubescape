import * as vscode from 'vscode';
import * as fs from 'fs';
import { Logger } from '../../utils/log';
import { DiagnosticReport } from '../../Kubescape/diagnostics/diagnosticReport/diagnosticReport';
import { WorkloadControlReport } from '../../Kubescape/diagnostics/diagnosticReport/workloadDiagnostics/controlDiagnostics/workloadControlReport';
import { DiagnosticReportsCollection } from '../../Kubescape/diagnostics/diagnosticsReportCollection';
import { get } from 'http';


export class KubescapePanelWebviewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'kubescape.KubescapePanel';

	private static _view?: vscode.WebviewView;
	private static _disposables: vscode.Disposable[] = [];
	private static _htmlContent: string = "<h1>Kubescape Panel Initialized.</h1><br> <h1>Open a yaml/dockerfile to see diagnostics.</h1>";
	private static loading: boolean = false;

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) { }

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
			// Enable javascript in the webview
			enableScripts: true,

			// And restrict the webview to only loading content from our extension's `media` directory.
			localResourceRoots: [
				vscode.Uri.joinPath(extensionUri, 'media'),
				vscode.Uri.joinPath(extensionUri, 'out/compiled'),
				this._extensionUri
			]
		};
	}

	public static updateHTMLContentWithDiagnostic(diagnosticReport: DiagnosticReport | undefined){
		if(!diagnosticReport){
			KubescapePanelWebviewProvider._htmlContent = fs.readFileSync("./template/error404.html", 'utf-8');
			return;
		}
		const controlReports: WorkloadControlReport[] = diagnosticReport.getControlReports();
		const imageVulnerabilityReports = diagnosticReport.getImageVulnerabilityReports();
		const workloadVulnerabilityReports = diagnosticReport.getWorkloadVulnerabilityReports();
		let controlReportHTML = "";
		let imageVulnerabilityReportHTML = "";
		let workloadVulnerabilityReportHTML = "";
		for(const controlReport of controlReports){
			controlReportHTML +=
			`
			<tr>
				<td>${controlReport.id}</td>
				<td>${controlReport.name}</td>
				<td>${controlReport.severity}</td>
				<td><a href="#" class="line-link" data-line="${controlReport.range.start.line}">${controlReport.range.start.line}</a></td>
			</tr>
			`;
		}
		Logger.debug(`HTML Content: ${KubescapePanelWebviewProvider._htmlContent}`);
		KubescapePanelWebviewProvider._htmlContent = `
			<table style = "border: 1px;">${controlReportHTML}</table>
			<script>
				const vscode = acquireVsCodeApi();
				document.addEventListener('click', (e) => {
					if (e.target.classList.contains('line-link')) {
						const line = e.target.getAttribute('data-line');
						vscode.postMessage({
							command: 'revealLine',
							line: parseInt(line+1)
						});
					}
				});
			</script>
		`;
		KubescapePanelWebviewProvider._view!.webview.html = KubescapePanelWebviewProvider._htmlContent;
		KubescapePanelWebviewProvider.loading = false;
	}

	private static handleWebviewMessage(message: any) {
		if (message.command === 'revealLine') {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const position = new vscode.Position(message.line - 1, 0);
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
			}
		}
	}

	public static _resetHTMlContent(){
		// KubescapePanelWebviewProvider._htmlContent = fs.readFileSync("./template/base.html", 'utf-8');
		KubescapePanelWebviewProvider._htmlContent = "<h1>Kubescape Panel Initialized.</h1><br> <h1>Open a yaml/dockerfile to see diagnostics.</h1>";
		KubescapePanelWebviewProvider._view!.webview.html = KubescapePanelWebviewProvider._htmlContent;
		KubescapePanelWebviewProvider.loading = false;
	}

	public static loadingPanel(){
		// KubescapePanelWebviewProvider._htmlContent = fs.readFileSync("./template/loading.html", 'utf-8');
		KubescapePanelWebviewProvider._htmlContent = "<h1>Kubecape scanning in process...</h1>";
		KubescapePanelWebviewProvider._view!.webview.html = KubescapePanelWebviewProvider._htmlContent;
		KubescapePanelWebviewProvider.loading = true;
	}

	public static stopLoadingPanel() {
		if(KubescapePanelWebviewProvider.loading){
			KubescapePanelWebviewProvider.loading = false;
			KubescapePanelWebviewProvider._resetHTMlContent();
		}
	}
}