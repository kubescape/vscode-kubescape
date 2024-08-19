import * as vscode from 'vscode';
import { IKubescapeConfig, KubescapeApi } from '@kubescape/install';
import * as kubescape from './Kubescape/kubescape';
import * as contextHelper from './utils/context';
import { KubescapeConfig } from './Kubescape/config/config';
import { Logger } from './utils/log';
import { VscodeUi } from './utils/ui';
import {
	ERROR_KUBESCAPE_NOT_INSTALLED
} from './Kubescape/globals';
import { DiagnosticReportsCollection } from './Kubescape/diagnostics/diagnosticsReportCollection';
import { kubescapeScanDocument } from './Kubescape/scan/scan';
import { KubescapeCodeActionProvider } from './Kubescape/codeActions/codeActions';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	contextHelper.setExtensionContext(context);

	let subscriptions = context.subscriptions;

	// Subscribe all the exported functions in kubescape.ts
	for (let exportedFunc of Object.keys(kubescape)){
		let fullFuncName = `kubescape.${exportedFunc}`;
		subscriptions.push(vscode.commands.registerCommand(fullFuncName, (args) => eval(`${fullFuncName}(args)`)));
	}

	subscriptions.push(
		vscode.languages.registerCodeActionsProvider('yaml', new KubescapeCodeActionProvider, {
			providedCodeActionKinds: KubescapeCodeActionProvider.providedCodeActionKinds
		})
	);
	subscriptions.push(
		vscode.languages.registerCodeActionsProvider('dockerfile', new KubescapeCodeActionProvider, {
			providedCodeActionKinds: KubescapeCodeActionProvider.providedCodeActionKinds
		})
	);

	const kubescapeApi = KubescapeApi.instance;
	await initializeExtension(kubescapeApi);


	if (!kubescapeApi.isInstalled) {
		Logger.error(ERROR_KUBESCAPE_NOT_INSTALLED);
		throw new Error;
	}

	/* Auto scan on save */
	addOnSaveTextDocument(context);

	/* Scan on new file open */
	addOnOpenTextDocument(context);

	/* Remove diagnostics on file close */
	vscode.workspace.onDidCloseTextDocument(doc => {
		DiagnosticReportsCollection.instance.removeFileDiagnostics(doc.fileName);
	});

	/* First scan of current file */
	if (vscode.window.activeTextEditor) {
		const doc = vscode.window.activeTextEditor.document;
		kubescapeScanDocument(doc);
	}

	Logger.info("Kubescape is active");
}

// this method is called when your extension is deactivated
export function deactivate() {
	contextHelper.setExtensionContext(undefined);
	Logger.info("Kubescape deactivated");
}

function addOnSaveTextDocument(context : vscode.ExtensionContext) {
	vscode.workspace.onDidSaveTextDocument((document) => {
		if (document.languageId !== 'yaml'  && document.languageId !== 'dockerfile') {
			return;
		}

		if (KubescapeConfig.instance.scanOnSave) {
			if (vscode.window.visibleTextEditors.some((e) => e.document.fileName === document.fileName)) {
				kubescapeScanDocument(document);
			}
		}
	}, null, context.subscriptions);
}

function addOnOpenTextDocument(context : vscode.ExtensionContext) {
	vscode.workspace.onDidOpenTextDocument((document) => {
		if (document.languageId !== 'yaml' && document.languageId !== 'dockerfile') {
			return;
		}

		kubescapeScanDocument(document);
	}, null, context.subscriptions);
}

async function initializeExtension(kubescapeApi : KubescapeApi) {
    const config = KubescapeConfig.instance;

	await kubescapeApi.setup(new VscodeUi, new class implements IKubescapeConfig {
        get version() : string {
            return config.kubescapeVersion;
        }
        get frameworksDirectory() : string | undefined {
            return config.customFrameworkDirectory;
        }
        get baseDirectory(): string {
            return config.kubescapeDir;
        }
        get requiredFrameworks(): string[] | undefined {
            return config.requiredFrameworks;
        }
        get scanFrameworks(): string[] | undefined {
            return config.scanFrameworks;
        }
    });
}
