import * as cp from 'child_process';

/**
 * Checks whether a given process ID is alive in the operating system.
 * Returns true if the process exists or if an error (like EPERM) indicates the process exists.
 * Returns false only when ESRCH confirms the process does not exist.
 */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        return err?.code !== 'ESRCH';
    }
}

/**
 * Awaits process exit up to a timeout.
 * Returns true if the process is confirmed dead, false if still alive.
 */
export async function waitForProcessExit(proc: cp.ChildProcess, timeoutMs: number = 3000): Promise<boolean> {
    if (!proc.pid || proc.exitCode !== null) {
        return true;
    }
    if (!isProcessAlive(proc.pid)) {
        return true;
    }

    return new Promise<boolean>((resolve) => {
        let timer: NodeJS.Timeout | null = null;

        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            proc.removeListener('exit', onExit);
            proc.removeListener('close', onExit);
        };

        const onExit = () => {
            cleanup();
            resolve(true);
        };

        proc.once('exit', onExit);
        proc.once('close', onExit);

        timer = setTimeout(() => {
            cleanup();
            const alive = proc.pid ? isProcessAlive(proc.pid) : false;
            resolve(!alive);
        }, timeoutMs);
    });
}

/**
 * Terminates a child process with escalating signals:
 * 1. SIGTERM (graceful)
 * 2. If still alive after half the timeout, SIGKILL (forced)
 * Returns true if process is confirmed dead.
 */
export async function terminateProcess(proc: cp.ChildProcess, timeoutMs: number = 3000): Promise<boolean> {
    if (!proc.pid || proc.exitCode !== null) {
        return true;
    }

    try {
        proc.kill('SIGTERM');
    } catch {
        // Ignored
    }

    const termTimeout = Math.max(100, Math.floor(timeoutMs / 2));
    const exited = await waitForProcessExit(proc, termTimeout);
    if (exited) {
        return true;
    }

    try {
        proc.kill('SIGKILL');
    } catch {
        // Ignored
    }

    const killTimeout = Math.max(100, Math.ceil(timeoutMs / 2));
    return await waitForProcessExit(proc, killTimeout);
}
