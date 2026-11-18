import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    findKubescapeExecutable,
    getExecutableNames,
    isExecutable,
    normalizePathDir,
    DiscoveryError
} from '../../server/discovery';

describe('Executable Discovery Tests', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ks-test-disc-'));
    });

    afterEach(async () => {
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    it('returns platform-appropriate executable candidate names', () => {
        const winNames = getExecutableNames('win32');
        assert.ok(winNames.includes('kubescape.exe'));
        assert.ok(winNames.includes('kubescape.cmd'));

        const linuxNames = getExecutableNames('linux');
        assert.deepStrictEqual(linuxNames, ['kubescape']);

        const macNames = getExecutableNames('darwin');
        assert.deepStrictEqual(macNames, ['kubescape']);
    });

    it('discovers binary when present on PATH', async () => {
        const binPath = path.join(tmpDir, 'kubescape');
        await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const resolved = await findKubescapeExecutable({
            pathEnv: tmpDir,
            platform: 'linux',
        });
        assert.strictEqual(resolved, binPath);
    });

    it('resolves configured custom absolute executable path', async () => {
        const binPath = path.join(tmpDir, 'custom-kubescape');
        await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const resolved = await findKubescapeExecutable({
            configuredPath: binPath,
            platform: 'darwin',
        });
        assert.strictEqual(resolved, binPath);
    });

    it('resolves custom relative path against workspace root', async () => {
        const binPath = path.join(tmpDir, 'bin', 'kubescape');
        await fs.promises.mkdir(path.dirname(binPath), { recursive: true });
        await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const resolved = await findKubescapeExecutable({
            configuredPath: './bin/kubescape',
            workspaceRoot: tmpDir,
            platform: 'darwin',
        });
        assert.strictEqual(resolved, binPath);
    });

    it('handles paths containing spaces correctly', async () => {
        const dirWithSpaces = path.join(tmpDir, 'My Tools and Binaries');
        await fs.promises.mkdir(dirWithSpaces, { recursive: true });
        const binPath = path.join(dirWithSpaces, 'kubescape');
        await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const resolved = await findKubescapeExecutable({
            configuredPath: binPath,
            platform: 'darwin',
        });
        assert.strictEqual(resolved, binPath);
    });

    it('resolves Windows .exe extension automatically if omitted in settings', async () => {
        const binPath = path.join(tmpDir, 'kubescape.exe');
        await fs.promises.writeFile(binPath, 'dummy exe binary');

        const resolved = await findKubescapeExecutable({
            configuredPath: path.join(tmpDir, 'kubescape'),
            platform: 'win32',
        });
        assert.strictEqual(resolved, binPath);
    });

    it('resolves binary inside directory when user configures legacy dirPath directory', async () => {
        const binPath = path.join(tmpDir, 'kubescape');
        await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const resolved = await findKubescapeExecutable({
            configuredPath: tmpDir,
            platform: 'linux',
        });
        assert.strictEqual(resolved, binPath);
    });

    it('rejects configured path when file does not exist', async () => {
        const nonExistent = path.join(tmpDir, 'does-not-exist');
        await assert.rejects(
            async () => {
                await findKubescapeExecutable({ configuredPath: nonExistent });
            },
            (err: any) => {
                assert.ok(err instanceof DiscoveryError);
                assert.strictEqual(err.code, 'NOT_FOUND');
                assert.ok(err.message.includes('does not exist'));
                return true;
            }
        );
    });

    it('rejects configured file if it lacks executable permissions on POSIX', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const binPath = path.join(tmpDir, 'kubescape-no-exec');
        // Mode 0o644 -> not executable
        await fs.promises.writeFile(binPath, 'text content', { mode: 0o644 });

        await assert.rejects(
            async () => {
                await findKubescapeExecutable({
                    configuredPath: binPath,
                    platform: 'darwin',
                });
            },
            (err: any) => {
                assert.ok(err instanceof DiscoveryError);
                assert.strictEqual(err.code, 'NOT_EXECUTABLE');
                assert.ok(err.message.includes('not executable'));
                return true;
            }
        );
    });

    it('throws clear error when executable is not found on PATH and not configured', async () => {
        await assert.rejects(
            async () => {
                await findKubescapeExecutable({
                    pathEnv: tmpDir, // empty dir
                    configuredPath: undefined,
                });
            },
            (err: any) => {
                assert.ok(err instanceof DiscoveryError);
                assert.strictEqual(err.code, 'NOT_FOUND');
                assert.ok(err.message.includes('not found on PATH'));
                return true;
            }
        );
    });

    it('isExecutable returns false for directory', async () => {
        const isExe = await isExecutable(tmpDir);
        assert.strictEqual(isExe, false);
    });

    describe('PATH normalization and quoted entries', () => {
        it('normalizes quoted Windows PATH entries by stripping matching surrounding quotes', () => {
            assert.strictEqual(
                normalizePathDir('"C:\\Program Files\\Kubescape"'),
                'C:\\Program Files\\Kubescape'
            );
            assert.strictEqual(
                normalizePathDir('   "C:\\Program Files\\Kubescape"   '),
                'C:\\Program Files\\Kubescape'
            );
            assert.strictEqual(
                normalizePathDir('C:\\Program Files\\Kubescape'),
                'C:\\Program Files\\Kubescape'
            );
            assert.strictEqual(
                normalizePathDir('""'),
                ''
            );
            assert.strictEqual(
                normalizePathDir('   '),
                ''
            );
            // Does not strip unmatched or internal quotes
            assert.strictEqual(
                normalizePathDir('C:\\Tools"with"quote'),
                'C:\\Tools"with"quote'
            );
        });

        it('discovers Windows executable when PATH entry is enclosed in double quotes', async () => {
            const dirWithSpaces = path.join(tmpDir, 'Program Files', 'Kubescape');
            await fs.promises.mkdir(dirWithSpaces, { recursive: true });
            const binPath = path.join(dirWithSpaces, 'kubescape.exe');
            await fs.promises.writeFile(binPath, 'dummy binary');

            // Quoted directory in Windows PATH style
            const quotedPathEnv = `"${dirWithSpaces}"`;
            const resolved = await findKubescapeExecutable({
                pathEnv: quotedPathEnv,
                platform: 'win32',
            });
            assert.strictEqual(resolved, binPath);
        });

        it('discovers executable in unquoted PATH entry with spaces', async () => {
            const dirWithSpaces = path.join(tmpDir, 'Unquoted Dir With Spaces');
            await fs.promises.mkdir(dirWithSpaces, { recursive: true });
            const binPath = path.join(dirWithSpaces, 'kubescape');
            await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

            const resolved = await findKubescapeExecutable({
                pathEnv: dirWithSpaces,
                platform: 'linux',
            });
            assert.strictEqual(resolved, binPath);
        });

        it('ignores empty entries and handles mixed quoted and unquoted PATH entries', async () => {
            const emptyDir = path.join(tmpDir, 'empty');
            const targetDir = path.join(tmpDir, 'Target Tools');
            await fs.promises.mkdir(emptyDir, { recursive: true });
            await fs.promises.mkdir(targetDir, { recursive: true });

            const binPath = path.join(targetDir, 'kubescape.exe');
            await fs.promises.writeFile(binPath, 'dummy binary');

            // Mixed PATH with empty entries: emptyDir;; "targetDir";;
            const mixedPathEnv = `${emptyDir};; "${targetDir}";;`;
            const resolved = await findKubescapeExecutable({
                pathEnv: mixedPathEnv,
                platform: 'win32',
            });
            assert.strictEqual(resolved, binPath);
        });
    });
});
