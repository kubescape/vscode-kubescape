import vscode = require('vscode');

export const getKubescapeConfig = (uri?: vscode.Uri) => {
    return getConfig('kubescape', uri);
};


function getConfig(section: string, uri?: vscode.Uri) {
    if (!uri) {
        if (vscode.window.activeTextEditor) {
            uri = vscode.window.activeTextEditor.document.uri;
        } else {
            uri = undefined;
        }
    }
    return vscode.workspace.getConfiguration(section, uri);
}
