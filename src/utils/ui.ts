import * as vscode from 'vscode';
import AbortController from "abort-controller";

import { KubescapeUi } from '@kubescape/install';

import { Logger } from './log';


export class VscodeUi implements KubescapeUi {
  constructor() {}

  slow<T>(title: string, work : () => Promise<T>) : Promise<T> {
    const opts = {
      location: vscode.ProgressLocation.Window,
      title: title,
      cancellable: false,
    };
    return Promise.resolve(vscode.window.withProgress(opts, work));
  }

  progress<T>(title: string, cancel: AbortController|null,
              body: (progress: (fraction: number) => void) => Promise<T>) {
    const opts = {
      location: cancel ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
      title: title,
      cancellable: cancel !== null,
    };
    const result = vscode.window.withProgress(opts, async (progress, canc) => {
      if (cancel) {
        canc.onCancellationRequested((_) => cancel.abort());
      }
      
      let lastFraction = 0;
      return body(fraction => {
        if (fraction > lastFraction) {
          progress.report({increment: 100 * (fraction - lastFraction)});
          lastFraction = fraction;
        }
      });
    });
    return Promise.resolve(result); // Thenable to real promise.
  }

  error(s: string) { Logger.error(s, true); }
  info(s: string) { Logger.info(s); }
  debug(s: string) { Logger.debug(s); }

  async showHelp(message: string, url: string) {
    if (await vscode.window.showInformationMessage(message, 'Open website')) {
      vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }
}