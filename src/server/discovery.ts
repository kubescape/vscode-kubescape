import * as fs from 'fs';
import * as path from 'path';

export interface DiscoveryOptions {
    configuredPath?: string | null;
    pathEnv?: string;
    platform?: string;
    workspaceRoot?: string;
}

export class DiscoveryError extends Error {
    constructor(
        message: string,
        public readonly code: 'NOT_FOUND' | 'NOT_A_FILE' | 'NOT_EXECUTABLE' | 'INVALID_PATH' | 'UNSUPPORTED_SCRIPT'
    ) {
        super(message);
        this.name = 'DiscoveryError';
    }
}

/**
 * Returns candidate binary names for the target platform.
 * Note: On Windows, only native executables (.exe) are supported. Batch scripts (.cmd, .bat)
 * are rejected to prevent shell-invocation security issues in vscode-languageclient.
 */
export function getExecutableNames(platform: string = process.platform): string[] {
    if (platform === 'win32') {
        return ['kubescape.exe'];
    }
    return ['kubescape'];
}

/**
 * Checks whether a given path points to an executable regular file.
 */
export async function isExecutable(filePath: string, platform: string = process.platform): Promise<boolean> {
    try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) {
            return false;
        }

        if (platform === 'win32') {
            const ext = path.extname(filePath).toLowerCase();
            if (ext === '.cmd' || ext === '.bat') {
                return false;
            }
            return ext === '.exe';
        }

        // On POSIX, check execute permission bits
        await fs.promises.access(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Normalizes a directory path from PATH environment variable.
 * Trims whitespace and removes matching surrounding double quotes,
 * while preserving internal quotes and paths containing spaces.
 */
export function normalizePathDir(dir: string): string {
    let trimmed = dir.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        trimmed = trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

/**
 * Resolves the path to the Kubescape executable according to the following precedence:
 * 1. Explicit configured path (settings)
 * 2. System PATH lookup
 *
 * Always returns the absolute path that passed the executable verification check.
 */
export async function findKubescapeExecutable(options: DiscoveryOptions = {}): Promise<string> {
    const platform = options.platform ?? process.platform;
    const configured = options.configuredPath?.trim();
    const baseDir = options.workspaceRoot || process.cwd();

    // 1. Explicit configured path
    if (configured) {
        let candidatePath = configured;
        if (!path.isAbsolute(candidatePath)) {
            candidatePath = path.resolve(baseDir, candidatePath);
        }

        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(candidatePath);
        } catch {
            // On Windows, if no extension was provided, attempt appending .exe
            if (platform === 'win32' && !path.extname(candidatePath)) {
                try {
                    const withExe = candidatePath + '.exe';
                    const statWithExe = await fs.promises.stat(withExe);
                    if (statWithExe.isFile()) {
                        return withExe;
                    }
                } catch {
                    // fall through to error below
                }
            }
            throw new DiscoveryError(
                `Configured Kubescape executable path does not exist: "${configured}"`,
                'NOT_FOUND'
            );
        }

        if (!stat.isFile()) {
            // If user pointed to a directory (e.g. legacy dirPath or a folder ending in .cmd), check for binary inside
            const names = getExecutableNames(platform);
            for (const name of names) {
                const subPath = path.resolve(candidatePath, name);
                if (await isExecutable(subPath, platform)) {
                    return subPath;
                }
            }
            throw new DiscoveryError(
                `Configured Kubescape path is a directory and contains no executable binary: "${configured}"`,
                'NOT_A_FILE'
            );
        }

        // Reject Windows batch scripts (.cmd, .bat) with an actionable error
        if (platform === 'win32') {
            const ext = path.extname(candidatePath).toLowerCase();
            if (ext === '.cmd' || ext === '.bat') {
                throw new DiscoveryError(
                    `Windows batch scripts (.cmd, .bat) cannot be launched securely by the language client. Please use the native "kubescape.exe" binary instead: "${configured}"`,
                    'UNSUPPORTED_SCRIPT'
                );
            }
        }

        const executable = await isExecutable(candidatePath, platform);
        if (!executable) {
            throw new DiscoveryError(
                `Configured Kubescape file is not executable (missing execution permissions): "${configured}"`,
                'NOT_EXECUTABLE'
            );
        }

        return candidatePath;
    }

    // 2. PATH resolution
    const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
    const delimiter = platform === 'win32' ? ';' : ':';
    const dirs = pathEnv
        .split(delimiter)
        .map(d => normalizePathDir(d))
        .filter(d => Boolean(d));
    const exeNames = getExecutableNames(platform);

    for (const dir of dirs) {
        // Resolve relative PATH entries to absolute paths against base directory
        const absDir = path.isAbsolute(dir) ? dir : path.resolve(baseDir, dir);
        for (const exeName of exeNames) {
            const fullPath = path.resolve(absDir, exeName);
            if (await isExecutable(fullPath, platform)) {
                return fullPath;
            }
        }
    }

    throw new DiscoveryError(
        'Kubescape executable not found on PATH or in settings. Please install Kubescape or configure "kubescape.executablePath".',
        'NOT_FOUND'
    );
}
