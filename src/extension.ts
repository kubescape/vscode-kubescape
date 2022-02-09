import * as vscode from 'vscode';

import * as kubescape from './Kubescape/kubescape'
import * as scan from './Kubescape/scan'
import * as contextHelper from './utils/context'
import * as kubescapeConfig from './Kubescape/config'

import { Logger } from './utils/log';
import { KubescapeBinaryInfo } from './Kubescape/info';
import { 
	CONFIG_SCAN_ON_SAVE, 
	ERROR_KUBESCAPE_NOT_INSTALLED 
} from './Kubescape/globals'

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	contextHelper.setExtensionContext(context)

	let subscriptions = context.subscriptions

	// Subscribe all the exported functions in kubescape.ts
	for (let exportedFunc of Object.keys(kubescape)){
		let fullFuncName = `kubescape.${exportedFunc}`
		subscriptions.push(vscode.commands.registerCommand(fullFuncName, () => eval(`${fullFuncName}()`)))
	}

	const kubescapeBinaryInfo = KubescapeBinaryInfo.instance
	await initializeExtension(kubescapeBinaryInfo)


	if (!kubescapeBinaryInfo.isInstalled) {
		Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED)
		throw new Error
	}

	/* Auto scan on save */
	addOnSaveTextDocument(context)

	/* Scan on new file open */
	addOnOpenTextDocument(context)

	/* First scan of current file */
	if (vscode.window.activeTextEditor) {
		const doc = vscode.window.activeTextEditor.document
		scan.kubescapeScanYaml(doc)
	}

	Logger.info("Kubescape in active")
}

// this method is called when your extension is deactivated
export function deactivate() {
	contextHelper.setExtensionContext(undefined)
	Logger.info("Kubescape deactivated")
}

function addOnSaveTextDocument(context : vscode.ExtensionContext) {
	vscode.workspace.onDidSaveTextDocument((document) => {
		if (document.languageId !== 'yaml') {
			return;
		}

		const config = kubescapeConfig.getKubescapeConfig(document.uri)

		if (!!config[CONFIG_SCAN_ON_SAVE] && config[CONFIG_SCAN_ON_SAVE] !== "none") {
			if (vscode.window.visibleTextEditors.some((e) => e.document.fileName === document.fileName)) {
				scan.kubescapeScanYaml(document)
			}
		}
	}, null, context.subscriptions);
}

function addOnOpenTextDocument(context : vscode.ExtensionContext) {
	vscode.workspace.onDidOpenTextDocument((document) => {
		if (document.languageId !== 'yaml') {
			return;
		}

		scan.kubescapeScanYaml(document)
	}, null, context.subscriptions);
}

async function initializeExtension(kubescapeBinaryInfo : KubescapeBinaryInfo) {
	await kubescapeBinaryInfo.setup()
}
