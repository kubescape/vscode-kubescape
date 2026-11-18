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
        public readonly code: 'NOT_FOUND' | 'NOT_A_FILE' | 'NOT_EXECUTABLE' | 'INVALID_PATH'
    ) {
        super(message);
        this.name = 'DiscoveryError';
    }
}

/**
 * Returns candidate binary names for the target platform.
 */
export function getExecutableNames(platform: string = process.platform): string[] {
    if (platform === 'win32') {
        return ['kubescape.exe', 'kubescape.cmd', 'kubescape.bat', 'kubescape'];
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
            return ext === '.exe' || ext === '.cmd' || ext === '.bat' || ext === '';
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
 */
export async function findKubescapeExecutable(options: DiscoveryOptions = {}): Promise<string> {
    const platform = options.platform ?? process.platform;
    const configured = options.configuredPath?.trim();

    // 1. Explicit configured path
    if (configured) {
        let candidatePath = configured;
        if (!path.isAbsolute(candidatePath) && options.workspaceRoot) {
            candidatePath = path.resolve(options.workspaceRoot, candidatePath);
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
            // If user pointed to a directory (e.g. legacy dirPath), check for binary inside
            const names = getExecutableNames(platform);
            for (const name of names) {
                const subPath = path.join(candidatePath, name);
                if (await isExecutable(subPath, platform)) {
                    return subPath;
                }
            }
            throw new DiscoveryError(
                `Configured Kubescape path is a directory and contains no executable binary: "${configured}"`,
                'NOT_A_FILE'
            );
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
        for (const exeName of exeNames) {
            const fullPath = path.join(dir, exeName);
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
