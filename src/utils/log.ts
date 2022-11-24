import * as vscode from 'vscode';

enum LogLevels {
    debug, error, warning, info
}

export class Logger {
    private static _instance: Logger = new Logger();

    private channel : vscode.OutputChannel;


    private constructor() {
        if (!Logger._instance) {
            Logger._instance = this;
        }

        this.channel = vscode.window.createOutputChannel("kubescape");
    }

    private static log(level : LogLevels, message : string, ui : boolean) {
        let outputConsole = console.debug;
        let uiOutput = (message: string, ...items: string[]) : Thenable<string | undefined> => new Promise(res=>{});

        let longMessage = `${new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '')} ${message}`;
        switch(level) {
            case LogLevels.debug:
                longMessage = `[debug] ${longMessage}`;
                break;
            case LogLevels.error:
                longMessage = `[error] ${longMessage}`;
                uiOutput = vscode.window.showErrorMessage;
                outputConsole = console.error;
                break;
            case LogLevels.warning:
                longMessage = `[warn ] ${longMessage}`;
                uiOutput = vscode.window.showWarningMessage;
                outputConsole = console.warn;
                break;
            case LogLevels.info:
                longMessage = `[info ] ${longMessage}`;
                uiOutput = vscode.window.showInformationMessage;
                outputConsole = console.info;
                break;
            default: break;
        }

        this._instance.channel.appendLine(longMessage);
        outputConsole(longMessage);
        if (ui) {
            uiOutput(message);
        }
    }

    public static debug(message: string, ui = false) {
        this.log(LogLevels.debug, message, ui);
    }

    public static error(message: string, ui = false) {
        this.log(LogLevels.error, message, ui);
    }

    public static info(message: string, ui = false) {
        this.log(LogLevels.info, message, ui);
    }

    public static warning(message: string, ui = false) {
        this.log(LogLevels.warning, message, ui);
    }
}
