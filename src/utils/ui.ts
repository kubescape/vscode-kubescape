import * as vscode from 'vscode'
import AbortController from "abort-controller";

export function progress<T>(title : string, cancel : AbortController | null, 
    minimized: boolean,
    body: (progress: (completed : number, outOf: number) => void) => Promise<T>) {
    const opts = {
        location: minimized ? vscode.ProgressLocation.Window :
            vscode.ProgressLocation.Notification,
        title: title,
        cancellable: cancel !== null
    }

    const result = vscode.window.withProgress(opts, async (progress, canc) => {
        if (cancel) {
            canc.onCancellationRequested(_ => {
                cancel.abort()
            })
        }

        let lastFraction = 0
        return body((completed, outOf) => {
            const fraction = completed / outOf
            if (fraction > lastFraction) {
                progress.report({ increment: 100 * (fraction - lastFraction), message : `${completed}/${outOf}` })
                lastFraction = fraction
            }
        })
    })

    return Promise.resolve(result)
}