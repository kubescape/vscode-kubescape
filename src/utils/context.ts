import * as vscode from 'vscode'


let extensionContext : vscode.ExtensionContext | undefined = undefined

export function setExtensionContext(context : vscode.ExtensionContext | undefined) {
    extensionContext = context;
}

export function getExtensionContext() {
    return extensionContext;
}