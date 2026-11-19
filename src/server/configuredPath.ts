import * as os from 'os';

/**
 * Returns the Kubescape executable path the settings configure:
 * kubescape.executablePath, else the legacy kubescape.dirPath, else null.
 *
 * Before the language server, the extension expanded a leading "~" and "$NAME"
 * environment variables in kubescape.dirPath, so a dirPath such as "~/bin" or
 * "$HOME/bin" is expanded the same way.
 */
export function configuredExecutablePath(
    executablePath: string | null | undefined,
    dirPath: string | null | undefined,
    home: string = os.homedir(),
    env: NodeJS.ProcessEnv = process.env
): string | null {
    if (executablePath) {
        return executablePath;
    }
    if (!dirPath) {
        return null;
    }
    return expandLegacyPath(dirPath.trim(), home, env);
}

/**
 * Replaces a leading "~" with home, and each "$NAME" of a set environment
 * variable with its value. A "$NAME" that isn't set is left as it is.
 */
export function expandLegacyPath(value: string, home: string, env: NodeJS.ProcessEnv): string {
    let expanded = value;
    if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
        expanded = home + expanded.slice(1);
    }
    return expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => env[name] ?? match);
}
