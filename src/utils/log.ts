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

    private static log(level : LogLevels, message : string, ui : boolean) {
        let outputConsole = console.debug
        let uiOutput = (message: string, ...items: string[]) : Thenable<string | undefined> => new Promise(res=>{})

        let longMessage = `${new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '')} ${message}`
        switch(level) {
            case LogLevels.Debug:
                longMessage = `[debug] ${longMessage}`
                break;
            case LogLevels.Error:
                longMessage = `[error] ${longMessage}`
                uiOutput = vscode.window.showErrorMessage
                outputConsole = console.error
                break;
            case LogLevels.Warning:
                longMessage = `[warn ] ${longMessage}`
                uiOutput = vscode.window.showWarningMessage
                outputConsole = console.warn
                break;
            case LogLevels.Info:
                longMessage = `[info ] ${longMessage}`
                uiOutput = vscode.window.showInformationMessage
                outputConsole = console.info
                break;
            default: break
        }

        this._instance.channel.appendLine(longMessage)
        outputConsole(longMessage)
        if (ui) uiOutput(message)
    }

    public static debug(message: string, ui = false) {
        this.log(LogLevels.Debug, message, ui)
    }

    public static error(message: string, ui = false) {
        this.log(LogLevels.Error, message, ui)
    }

    public static info(message: string, ui = false) {
        this.log(LogLevels.Info, message, ui)
    }

    public static warning(message: string, ui = false) {
        this.log(LogLevels.Warning, message, ui)
    }
}
