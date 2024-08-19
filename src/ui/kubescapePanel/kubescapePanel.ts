import * as vscode from 'vscode';
import * as fs from 'fs';
import { Logger } from '../../utils/log';
import { DiagnosticReport } from '../../Kubescape/diagnostics/diagnosticReport/diagnosticReport';
import { WorkloadControlReport } from '../../Kubescape/diagnostics/diagnosticReport/workloadDiagnostics/controlDiagnostics/workloadControlReport';
import { DiagnosticReportsCollection } from '../../Kubescape/diagnostics/diagnosticsReportCollection';
import { get } from 'http';


export class KubescapePanelWebviewProvider implements vscode.WebviewViewProvider {

	public readonly viewType = 'kubescape.KubescapePanel';

	private _view?: vscode.WebviewView;
	private _disposables: vscode.Disposable[] = [];
	private _htmlContent: string = "";

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = this.getWebViewOptions(this._extensionUri);

		// webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
		webviewView.webview.html = this._htmlContent;

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

	private _updateHTMLContentWithDiagnostic(diagnosticReport: DiagnosticReport | undefined){
		if(!diagnosticReport){
			this._htmlContent = fs.readFileSync("./template/error404.html", 'utf-8');
			return;
		}
		const controlReports: WorkloadControlReport[] = diagnosticReport.getControlReports();
		const imageVulnerabilityReports = diagnosticReport.getImageVulnerabilityReports();
		const workloadVulnerabilityReports = diagnosticReport.getWorkloadVulnerabilityReports();
		this._resetHTMlContent();
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
			<td>${controlReport.range.start.line}</td>
			</tr>
			`;
		}
		// for(const imageVulnerabilityReport of imageVulnerabilityReports){
		// 	imageVulnerabilityReportHTML += 
		// 	`
		// 	<tr>
		// 	<td>${imageVulnerabilityReport.id}</td>
		// 	<td>${imageVulnerabilityReport.name}</td>
		// 	<td>${imageVulnerabilityReport.severity}</td>
		// 	</tr>
		// 	`;
		// }
		// for(const workloadVulnerabilityReport of workloadVulnerabilityReports){
		// 	workloadVulnerabilityReportHTML += 
		// 	`
		// 	<tr>
		// 	<td>${workloadVulnerabilityReport.id}</td>
		// 	<td>${workloadVulnerabilityReport.name}</td>
		// 	<td>${workloadVulnerabilityReport.severity}</td>
		// 	</tr>
		// 	`;
		// }
		// this._htmlContent = this._htmlContent.replace("{{controlReports}}", controlReportHTML);
		this._htmlContent = controlReportHTML+imageVulnerabilityReportHTML+workloadVulnerabilityReportHTML;
	}

	private _resetHTMlContent(){
		this._htmlContent = fs.readFileSync("./template/base.html", 'utf-8');
	}
}