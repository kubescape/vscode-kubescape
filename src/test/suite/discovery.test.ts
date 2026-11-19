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
    const hostPlatform = process.platform;
    const hostExeName = hostPlatform === 'win32' ? 'kubescape.exe' : 'kubescape';

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
        assert.deepStrictEqual(winNames, ['kubescape.exe']);
        assert.ok(!winNames.includes('kubescape'), 'Windows must not include extensionless kubescape');
        assert.ok(!winNames.includes('kubescape.cmd'), 'Windows batch .cmd must not be candidate');
        assert.ok(!winNames.includes('kubescape.bat'), 'Windows batch .bat must not be candidate');

        const linuxNames = getExecutableNames('linux');
        assert.deepStrictEqual(linuxNames, ['kubescape']);

        const macNames = getExecutableNames('darwin');
        assert.deepStrictEqual(macNames, ['kubescape']);
    });

    describe('Windows batch script rejection (Finding 5)', () => {
        it('rejects configured .cmd batch script on Windows with UNSUPPORTED_SCRIPT', async () => {
            const cmdPath = path.join(tmpDir, 'kubescape.cmd');
            await fs.promises.writeFile(cmdPath, '@echo off\r\n');

            await assert.rejects(
                async () => {
                    await findKubescapeExecutable({
                        configuredPath: cmdPath,
                        platform: 'win32',
                    });
                },
                (err: any) => {
                    assert.ok(err instanceof DiscoveryError);
                    assert.strictEqual(err.code, 'UNSUPPORTED_SCRIPT');
                    assert.ok(err.message.includes('Windows batch scripts'));
                    assert.ok(err.message.includes('kubescape.exe'));
                    return true;
                }
            );
        });

        it('rejects configured .bat batch script on Windows with UNSUPPORTED_SCRIPT', async () => {
            const batPath = path.join(tmpDir, 'kubescape.bat');
            await fs.promises.writeFile(batPath, '@echo off\r\n');

            await assert.rejects(
                async () => {
                    await findKubescapeExecutable({
                        configuredPath: batPath,
                        platform: 'win32',
                    });
                },
                (err: any) => {
                    assert.ok(err instanceof DiscoveryError);
                    assert.strictEqual(err.code, 'UNSUPPORTED_SCRIPT');
                    assert.ok(err.message.includes('Windows batch scripts'));
                    return true;
                }
            );
        });

        it('isExecutable rejects .cmd, .bat, and extensionless files on Windows while accepting .exe', async () => {
            const cmdPath = path.join(tmpDir, 'test.cmd');
            const batPath = path.join(tmpDir, 'test.bat');
            const extensionlessPath = path.join(tmpDir, 'test');
            const exePath = path.join(tmpDir, 'test.exe');

            await fs.promises.writeFile(cmdPath, '@echo off');
            await fs.promises.writeFile(batPath, '@echo off');
            await fs.promises.writeFile(extensionlessPath, '#!/bin/sh');
            await fs.promises.writeFile(exePath, 'binary content');

            assert.strictEqual(await isExecutable(cmdPath, 'win32'), false);
            assert.strictEqual(await isExecutable(batPath, 'win32'), false);
            assert.strictEqual(await isExecutable(extensionlessPath, 'win32'), false);
            assert.strictEqual(await isExecutable(exePath, 'win32'), true);
        });

        it('findKubescapeExecutable accepts directory ending in .cmd containing kubescape.exe', async () => {
            const cmdDir = path.join(tmpDir, 'tools.cmd');
            await fs.promises.mkdir(cmdDir, { recursive: true });
            const binPath = path.join(cmdDir, 'kubescape.exe');
            await fs.promises.writeFile(binPath, 'dummy exe content');

            const resolved = await findKubescapeExecutable({
                configuredPath: cmdDir,
                platform: 'win32',
            });
            assert.strictEqual(resolved, binPath);
            assert.ok(path.isAbsolute(resolved));
        });

        it('rejects configured extensionless file on Windows with NOT_EXECUTABLE', async () => {
            const extensionlessPath = path.join(tmpDir, 'kubescape');
            await fs.promises.writeFile(extensionlessPath, '#!/bin/sh\necho hi');

            await assert.rejects(
                async () => {
                    await findKubescapeExecutable({
                        configuredPath: extensionlessPath,
                        platform: 'win32',
                    });
                },
                (err: any) => {
                    assert.ok(err instanceof DiscoveryError);
                    assert.strictEqual(err.code, 'NOT_EXECUTABLE');
                    return true;
                }
            );
        });
    });

    describe('Cross-platform and host-safe filesystem discovery (Finding 8 & 9)', () => {
        it('discovers binary when present on PATH using host platform conventions', async () => {
            const binPath = path.join(tmpDir, hostExeName);
            await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

            const resolved = await findKubescapeExecutable({
                pathEnv: tmpDir,
                platform: hostPlatform,
            });
            assert.strictEqual(resolved, binPath);
            assert.ok(path.isAbsolute(resolved), 'Returned path must be absolute');
        });

        it('resolves configured custom absolute executable path', async () => {
            const binPath = path.join(tmpDir, hostExeName);
            await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

            const resolved = await findKubescapeExecutable({
                configuredPath: binPath,
                platform: hostPlatform,
            });
            assert.strictEqual(resolved, binPath);
            assert.ok(path.isAbsolute(resolved));
        });

        it('resolves custom relative path against workspace root and returns absolute path', async () => {
            const binPath = path.join(tmpDir, 'bin', hostExeName);
            await fs.promises.mkdir(path.dirname(binPath), { recursive: true });
            await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

            const relativeConfig = `./bin/${hostExeName}`;
            const resolved = await findKubescapeExecutable({
                configuredPath: relativeConfig,
                workspaceRoot: tmpDir,
                platform: hostPlatform,
            });
            assert.strictEqual(resolved, binPath);
            assert.ok(path.isAbsolute(resolved), 'Resolved relative path must be absolute');
        });

        it('resolves relative PATH entry against workspace root to absolute path', async () => {
            const relDirName = 'local-tools';
            const absDir = path.join(tmpDir, relDirName);
            await fs.promises.mkdir(absDir, { recursive: true });
            const binPath = path.join(absDir, hostExeName);
            await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

            const resolved = await findKubescapeExecutable({
                pathEnv: relDirName,
                workspaceRoot: tmpDir,
                platform: hostPlatform,
            });
            assert.strictEqual(resolved, binPath);
            assert.ok(path.isAbsolute(resolved));
        });

        it('handles paths containing spaces correctly', async () => {
            const dirWithSpaces = path.join(tmpDir, 'My Tools and Binaries');
            await fs.promises.mkdir(dirWithSpaces, { recursive: true });
            const binPath = path.join(dirWithSpaces, hostExeName);
            await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

            const resolved = await findKubescapeExecutable({
                configuredPath: binPath,
                platform: hostPlatform,
            });
            assert.strictEqual(resolved, binPath);
            assert.ok(path.isAbsolute(resolved));
        });

        it('resolves binary inside directory when user configures legacy dirPath directory', async () => {
            const binPath = path.join(tmpDir, hostExeName);
            await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

            const resolved = await findKubescapeExecutable({
                configuredPath: tmpDir,
                platform: hostPlatform,
            });
            assert.strictEqual(resolved, binPath);
            assert.ok(path.isAbsolute(resolved));
        });

        it('resolves Windows .exe extension automatically if omitted in settings', async () => {
            const binPath = path.join(tmpDir, 'kubescape.exe');
            await fs.promises.writeFile(binPath, 'dummy exe binary');

            const resolved = await findKubescapeExecutable({
                configuredPath: path.join(tmpDir, 'kubescape'),
                platform: 'win32',
            });
            assert.strictEqual(resolved, binPath);
            assert.ok(path.isAbsolute(resolved));
        });
    });

    describe('Error handling', () => {
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
                        platform: hostPlatform,
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
            assert.ok(path.isAbsolute(resolved));
        });

        it('discovers executable in unquoted PATH entry with spaces', async () => {
            const dirWithSpaces = path.join(tmpDir, 'Unquoted Dir With Spaces');
            await fs.promises.mkdir(dirWithSpaces, { recursive: true });
            const binPath = path.join(dirWithSpaces, hostExeName);
            await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

            const resolved = await findKubescapeExecutable({
                pathEnv: dirWithSpaces,
                platform: hostPlatform,
            });
            assert.strictEqual(resolved, binPath);
            assert.ok(path.isAbsolute(resolved));
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
            assert.ok(path.isAbsolute(resolved));
        });
    });
});
