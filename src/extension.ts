import * as vscode from 'vscode';

import * as install from './Kubescape/install'
import * as kubescape from './Kubescape/kubescape'
import * as scan from './Kubescape/scan'
import * as contextHelper from './utils/context'
import * as kubescapeConfig from './Kubescape/config'

import { CONFIG_SCAN_FRAMEWORKS, CONFIG_SCAN_ON_SAVE } from './Kubescape/globals'

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	contextHelper.setExtensionContext(context)

	let hasKubescape = await install.ensureKubescapeTool()

	if (!hasKubescape) {
		return
	}

	let subscriptions = context.subscriptions;

	// Subscribe all the exported functions in kubescape.ts
	for (let exportedFunc of Object.keys(kubescape)){
		let fullFuncName = `kubescape.${exportedFunc}`
		subscriptions.push(vscode.commands.registerCommand(fullFuncName, () => eval(`${fullFuncName}()`)));
	}

	addOnSaveTextDocumentListeners(context)

	if (vscode.window.activeTextEditor) {
		const doc = vscode.window.activeTextEditor.document
		scan.kubescapeScanYaml(doc.uri.fsPath, getKubescapeFrameworks(doc))
	}
}

// this method is called when your extension is deactivated
export function deactivate() {
	contextHelper.setExtensionContext(undefined)
}

function addOnSaveTextDocumentListeners(ctx: vscode.ExtensionContext) {
	vscode.workspace.onDidSaveTextDocument(
		(document) => {
			if (document.languageId !== 'yaml') {
				return;
			}
			const config = kubescapeConfig.getKubescapeConfig(document.uri)

			if (!!config[CONFIG_SCAN_ON_SAVE] && config[CONFIG_SCAN_ON_SAVE] !== "none") {
				if (vscode.window.visibleTextEditors.some((e) => e.document.fileName === document.fileName)) {
					scan.kubescapeScanYaml(document.uri.fsPath, getKubescapeFrameworks(document))
				}
			}
		},
		null,
		ctx.subscriptions
	);
}

function getKubescapeFrameworks(document: vscode.TextDocument): string {
	const config = kubescapeConfig.getKubescapeConfig(document.uri)
	let frameworks: string
	if (config[CONFIG_SCAN_FRAMEWORKS]) {
		let configFrameworksArray = config[CONFIG_SCAN_FRAMEWORKS]
		frameworks = configFrameworksArray.join(',')

	} else {
		frameworks = 'nsa'
	}

	return frameworks
}