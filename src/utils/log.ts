import * as vscode from 'vscode'

enum LogLevels {
    Debug, Error, Warning, Info
}

export class Logger {
    private static _instance: Logger = new Logger();

    private channel : vscode.OutputChannel


    private constructor() {
        if (!Logger._instance) {
            Logger._instance = this
        }

        this.channel = vscode.window.createOutputChannel("kubescape")
    }

    public static debug(message: string, ui = false) {
        this._instance.channel.appendLine(message)
        if (ui) vscode.window.showInformationMessage(message)
        addToDebug(LogLevels.Debug, message)
    }

    public static error(message: string, ui = false) {
        this._instance.channel.appendLine(message)
        if (ui) vscode.window.showErrorMessage(message)
        addToDebug(LogLevels.Error, message)
    }

    public static info(message: string, ui = false) {
        this._instance.channel.appendLine(message)
        if (ui) vscode.window.showInformationMessage(message)
        addToDebug(LogLevels.Info, message)
    }

    public static warning(message: string, ui = false) {
        this._instance.channel.appendLine(message)
        if (ui) vscode.window.showWarningMessage(message)
        addToDebug(LogLevels.Warning, message)
    }
}

function addToDebug(level : LogLevels, message : string) {
    if (vscode.debug.activeDebugSession != undefined) {
        switch (level) {
            case LogLevels.Debug:
                console.debug(message)
                break;
            case LogLevels.Error:
                console.error(message)
                break;
            case LogLevels.Warning:
                console.warn(message)
                break;
            case LogLevels.Info:
                console.info(message)
                break;
            default: break
        }
    }
}