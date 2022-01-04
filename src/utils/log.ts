import * as vscode from 'vscode'

enum LogLevels {
    Debug, Error, Warning, Info
}

function log(level: LogLevels, message: string, ui : boolean) {
    switch (level) {
        case LogLevels.Debug:
            console.debug(message)
            if (ui) vscode.window.showInformationMessage(message)
            break;
        case LogLevels.Error:
            console.error(message)
            if (ui) vscode.window.showErrorMessage(message)
            break;
        case LogLevels.Warning:
            console.warn(message)
            if (ui) vscode.window.showWarningMessage(message)
            break;
        case LogLevels.Info:
            console.info(message)
            if (ui) vscode.window.showInformationMessage(message)
            break;
        default: break
    }
}

export function logDebug(message : string, ui = false) {
    log(LogLevels.Debug, message, ui)
}

export function logInfo(message: string, ui = true) {
    log(LogLevels.Info, message, ui)
}

export function logWarning(message: string, ui = false) {
    log(LogLevels.Warning, message, ui)
}

export function logError(message: string, ui = true) {
    log(LogLevels.Error, message, ui)
}