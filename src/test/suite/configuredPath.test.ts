import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configuredExecutablePath, expandLegacyPath } from '../../server/configuredPath';
import { findKubescapeExecutable } from '../../server/discovery';

describe('Configured executable path', () => {
    const home = path.join(os.tmpdir(), 'ks-home');

    it('prefers kubescape.executablePath and leaves it as it is', () => {
        assert.strictEqual(configuredExecutablePath('~/ks/kubescape', '~/bin', home, {}), '~/ks/kubescape');
    });

    it('returns null when neither setting is set', () => {
        assert.strictEqual(configuredExecutablePath(null, null, home, {}), null);
        assert.strictEqual(configuredExecutablePath(undefined, '', home, {}), null);
    });

    it('expands a leading ~ in the legacy dirPath', () => {
        assert.strictEqual(configuredExecutablePath(null, '~', home, {}), home);
        assert.strictEqual(configuredExecutablePath(null, '~/bin', home, {}), home + '/bin');
        assert.strictEqual(configuredExecutablePath(null, ' ~\\bin ', home, {}), home + '\\bin');
    });

    it('expands $NAME environment variables in the legacy dirPath', () => {
        const env: NodeJS.ProcessEnv = Object.fromEntries([
            ['KS_ROOT', '/opt/kubescape'],
            ['HOME', '/home/dev'],
            ['HOMEDIR', '/elsewhere'],
        ]);
        assert.strictEqual(expandLegacyPath('$KS_ROOT/bin', home, env), '/opt/kubescape/bin');
        assert.strictEqual(expandLegacyPath('$HOMEDIR/bin', home, env), '/elsewhere/bin');
        assert.strictEqual(expandLegacyPath('$HOME/bin', home, env), '/home/dev/bin');
        assert.strictEqual(expandLegacyPath('$UNSET_VAR/bin', home, env), '$UNSET_VAR/bin');
    });

    it('leaves a ~ that does not start the path, or names a user, as it is', () => {
        assert.strictEqual(expandLegacyPath('~other/bin', home, {}), '~other/bin');
        assert.strictEqual(expandLegacyPath('tools/~/bin', home, {}), 'tools/~/bin');
    });

    describe('with discovery', () => {
        let tmpDir: string;
        const hostExeName = process.platform === 'win32' ? 'kubescape.exe' : 'kubescape';

        beforeEach(async () => {
            tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ks-test-dirpath-'));
        });

        afterEach(async () => {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        });

        it('finds the binary in a legacy dirPath under ~, not under the workspace', async () => {
            const fakeHome = path.join(tmpDir, 'home');
            const workspace = path.join(tmpDir, 'workspace');
            await fs.promises.mkdir(path.join(fakeHome, 'bin'), { recursive: true });
            await fs.promises.mkdir(workspace);
            const binPath = path.join(fakeHome, 'bin', hostExeName);
            await fs.promises.writeFile(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

            const resolved = await findKubescapeExecutable({
                configuredPath: configuredExecutablePath(null, '~/bin', fakeHome, {}),
                workspaceRoot: workspace,
            });
            assert.strictEqual(resolved, binPath);
        });
    });
});
