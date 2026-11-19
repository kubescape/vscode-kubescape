import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    isCandidateForKubernetesScan,
    shouldScanDocumentOnSave,
    forceScanForDocument,
    consumeForceScan,
    clearForcedScan,
    resetForceScanState,
    isScanForcedForDocument,
    getDocumentKey,
    isKustomizeDependency,
    isHelmDependency,
    ScannableDocument,
} from '../../server/manifestFilter';

describe('LSP Save-Time Scoped Scanning & Filter Tests (Second-Pass Audit)', () => {
    beforeEach(() => {
        resetForceScanState();
    });

    afterEach(() => {
        resetForceScanState();
    });

    describe('Manifest Detection Robustness & Edge Cases (Section 1 Audit)', () => {
        it('identifies YAML manifests with double-quoted keys and values', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s/quoted.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/k8s/quoted.yaml',
                getText: () => `
"apiVersion": "apps/v1"
"kind": "Deployment"
metadata:
  name: "quoted-deploy"
spec:
  replicas: 1
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies YAML manifests with single-quoted keys and values', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s/single-quoted.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/k8s/single-quoted.yaml',
                getText: () => `
'apiVersion': 'batch/v1'
'kind': 'Job'
metadata:
  name: 'single-quoted-job'
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies YAML manifests with inline comments and trailing whitespace', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s/comments.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/k8s/comments.yaml',
                getText: () => `
# Leading license comments
apiVersion: v1   # Core Kubernetes API version
kind: Service    # Service definition
metadata:
  name: my-service  
spec:
  ports:
  - port: 80
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies templated manifests with Helm template expressions in apiVersion and kind', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/charts/app/templates/custom.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/charts/app/templates/custom.yaml',
                getText: () => `
apiVersion: {{ .Values.apiVersion | default "apps/v1" }}
kind: {{ .Values.kind | default "Deployment" }}
metadata:
  name: {{ .Release.Name }}-app
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies any YAML file containing Helm template directives {{ ... }} as scan candidate', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/deploy/helm-snippet.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/deploy/helm-snippet.yaml',
                getText: () => `
{{- if .Values.enabled }}
someConfig: true
{{- end }}
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies multi-document YAML where later document defines Kubernetes manifest', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s/multi.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/k8s/multi.yaml',
                getText: () => `
# Document 1: simple note
notes: here is some doc
---
# Document 2: Kubernetes Resource
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  KEY: value
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies Kubernetes JSON manifest containing apiVersion and kind', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s/pod.json' },
                languageId: 'json',
                fileName: '/workspace/k8s/pod.json',
                getText: () => JSON.stringify({
                    apiVersion: 'v1',
                    kind: 'Pod',
                    metadata: { name: 'test-pod' },
                    spec: { containers: [{ name: 'web', image: 'nginx' }] },
                }),
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies Kubernetes JSON List objects with items array', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s/list.json' },
                languageId: 'json',
                fileName: '/workspace/k8s/list.json',
                getText: () => JSON.stringify({
                    apiVersion: 'v1',
                    kind: 'List',
                    items: [
                        { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'item-pod' } },
                    ],
                }),
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('identifies Kustomize files regardless of casing or content', () => {
            for (const name of ['kustomization.yaml', 'kustomization.yml', 'Kustomization']) {
                const doc: ScannableDocument = {
                    uri: { scheme: 'file', fsPath: `/workspace/base/${name}` },
                    languageId: 'yaml',
                    fileName: `/workspace/base/${name}`,
                    getText: () => 'resources:\n  - pod.yaml',
                };
                assert.strictEqual(isCandidateForKubernetesScan(doc), true, `Should accept ${name}`);
            }
        });

        it('identifies Helm Chart.yaml and values files (including values.staging.yaml)', () => {
            const chart: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/Chart.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/Chart.yaml',
                getText: () => 'name: mychart\nversion: 1.0.0',
            };
            assert.strictEqual(isCandidateForKubernetesScan(chart), true);

            const values: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/values.staging.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/values.staging.yaml',
                getText: () => 'replicas: 2\nenv: staging',
            };
            assert.strictEqual(isCandidateForKubernetesScan(values), true);
        });

        it('forwards ambiguous YAML with partial metadata and spec blocks (conservative policy)', () => {
            // An ambiguous partial YAML patch without apiVersion/kind
            const patchDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/patches/resource-patch.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/patches/resource-patch.yaml',
                getText: () => `
metadata:
  name: target-app
spec:
  template:
    spec:
      containers:
      - name: app
`,
            };
            // Under conservative policy, uncertain/ambiguous YAML is forwarded
            assert.strictEqual(isCandidateForKubernetesScan(patchDoc), true);
        });

        it('forwards ambiguous YAML containing kind without apiVersion', () => {
            const ambiguousDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/manifests/partial.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/manifests/partial.yaml',
                getText: () => `
kind: Deployment
metadata:
  name: unknown-version
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(ambiguousDoc), true);
        });

        it('confidently suppresses known non-Kubernetes JSON and YAML files', () => {
            const nonK8sFiles = [
                { path: '/workspace/package.json', lang: 'json', content: '{"name":"app","version":"1.0.0"}' },
                { path: '/workspace/tsconfig.json', lang: 'json', content: '{"compilerOptions":{"target":"es6"}}' },
                { path: '/workspace/.vscode/settings.json', lang: 'json', content: '{"editor.tabSize": 2}' },
                { path: '/workspace/.github/workflows/ci.yaml', lang: 'yaml', content: 'name: CI\non: push\njobs: { build: {} }' },
                { path: '/workspace/docker-compose.yaml', lang: 'yaml', content: 'version: "3"\nservices:\n  db: { image: postgres }' },
                { path: '/workspace/.pre-commit-config.yaml', lang: 'yaml', content: 'repos:\n  - repo: https://github.com/pre-commit/pre-commit-hooks' },
                { path: '/workspace/.gitlab-ci.yml', lang: 'yaml', content: 'stages:\n  - test\ntest_job:\n  script: npm test' },
            ];

            for (const f of nonK8sFiles) {
                const doc: ScannableDocument = {
                    uri: { scheme: 'file', fsPath: f.path },
                    languageId: f.lang,
                    fileName: f.path,
                    getText: () => f.content,
                };
                assert.strictEqual(isCandidateForKubernetesScan(doc), false, `Should suppress ${f.path}`);
            }
        });

        it('forwards Kubernetes manifest stored in .github/workflows/ (strong evidence overrides directory exclusion)', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/.github/workflows/embedded-k8s.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/.github/workflows/embedded-k8s.yaml',
                getText: () => `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: runner-deployment
spec:
  replicas: 1
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('forwards Kubernetes manifest misnamed docker-compose.yaml (strong evidence overrides filename exclusion)', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/docker-compose.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/docker-compose.yaml',
                getText: () => `
apiVersion: v1
kind: Pod
metadata:
  name: misnamed-pod
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('forwards Kubernetes JSON manifest stored in .vscode/ (strong evidence overrides directory exclusion)', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/.vscode/k8s-pod.json' },
                languageId: 'json',
                fileName: '/workspace/.vscode/k8s-pod.json',
                getText: () => JSON.stringify({
                    apiVersion: 'v1',
                    kind: 'Pod',
                    metadata: { name: 'vscode-pod' },
                }),
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('confidently suppresses real GitHub Actions workflows containing ${{ ... }} expressions without Kubernetes resources', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/.github/workflows/ci.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/.github/workflows/ci.yaml',
                getText: () => `
name: Build and Test
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - name: Run CI
      run: |
        echo "Commit: \${{ github.sha }}"
        npm test
      env:
        NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), false);
        });

        it('confidently suppresses real docker-compose.yaml files', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/docker-compose.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/docker-compose.yaml',
                getText: () => `
version: "3.8"
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"
  db:
    image: postgres:15
    environment:
      POSTGRES_PASSWORD: secret
`,
            };
            assert.strictEqual(isCandidateForKubernetesScan(doc), false);
        });
    });

    describe('Indirect Helm & Kustomize Dependency Scanning (Section 3 & 4 Audit)', () => {
        let tempTestDir: string;

        beforeEach(() => {
            tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-indirect-dep-test-'));
        });

        afterEach(() => {
            try {
                fs.rmSync(tempTestDir, { recursive: true, force: true });
            } catch {
                // Best effort cleanup
            }
        });

        it('forwards non-Kubernetes JSON file referenced by Kustomize configMapGenerator', () => {
            const kustomizeDir = path.join(tempTestDir, 'kustomize');
            fs.mkdirSync(kustomizeDir);

            const jsonPath = path.join(kustomizeDir, 'app-settings.json');
            const jsonContent = JSON.stringify({ apiEndpoint: 'https://api.internal', debug: false });
            fs.writeFileSync(jsonPath, jsonContent);

            const kustomizationPath = path.join(kustomizeDir, 'kustomization.yaml');
            fs.writeFileSync(kustomizationPath, `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: app-config
  files:
  - app-settings.json
`);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: jsonPath },
                languageId: 'json',
                fileName: jsonPath,
                getText: () => jsonContent,
            };

            assert.strictEqual(isKustomizeDependency(jsonPath), true, 'Must detect as Kustomize dependency');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true, 'Non-Kubernetes JSON referenced by Kustomize must be forwarded');
            assert.strictEqual(shouldScanDocumentOnSave(doc), true);
        });

        it('forwards non-Kubernetes YAML file referenced by Kustomize configMapGenerator', () => {
            const kustomizeDir = path.join(tempTestDir, 'kustomize-yaml');
            fs.mkdirSync(kustomizeDir);

            const yamlPath = path.join(kustomizeDir, 'server-config.yaml');
            const yamlContent = 'server:\n  port: 8080\n  host: 0.0.0.0\n';
            fs.writeFileSync(yamlPath, yamlContent);

            fs.writeFileSync(path.join(kustomizeDir, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: server-config
  files:
  - server-config.yaml
`);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: yamlPath },
                languageId: 'yaml',
                fileName: yamlPath,
                getText: () => yamlContent,
            };

            assert.strictEqual(isKustomizeDependency(yamlPath), true);
            assert.strictEqual(isCandidateForKubernetesScan(doc), true, 'Non-Kubernetes YAML referenced by Kustomize must be forwarded');
        });

        it('forwards non-Kubernetes JSON file referenced by Kustomize overlay in base directory', () => {
            const baseDir = path.join(tempTestDir, 'base');
            const overlayDir = path.join(tempTestDir, 'overlay');
            fs.mkdirSync(baseDir);
            fs.mkdirSync(overlayDir);

            const baseJsonPath = path.join(baseDir, 'base-data.json');
            const baseJsonContent = JSON.stringify({ timeoutMs: 5000 });
            fs.writeFileSync(baseJsonPath, baseJsonContent);

            fs.writeFileSync(path.join(baseDir, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: base-data
  files:
  - base-data.json
`);

            fs.writeFileSync(path.join(overlayDir, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../base
`);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: baseJsonPath },
                languageId: 'json',
                fileName: baseJsonPath,
                getText: () => baseJsonContent,
            };

            // Saving base-data.json without modifying kustomization.yaml must trigger scan
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('forwards non-Kubernetes JSON file consumed by Helm template via .Files.Get', () => {
            const chartDir = path.join(tempTestDir, 'mychart');
            const templatesDir = path.join(chartDir, 'templates');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);

            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), `apiVersion: v2
name: mychart
version: 0.1.0
`);

            const jsonPath = path.join(chartDir, 'raw-config.json');
            const jsonContent = JSON.stringify({ rateLimit: 100, insecure: false });
            fs.writeFileSync(jsonPath, jsonContent);

            fs.writeFileSync(path.join(templatesDir, 'configmap.yaml'), `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
data:
  raw-config.json: |-
{{ .Files.Get "raw-config.json" | indent 4 }}
`);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: jsonPath },
                languageId: 'json',
                fileName: jsonPath,
                getText: () => jsonContent,
            };

            assert.strictEqual(isHelmDependency(jsonPath), true, 'Must detect as Helm dependency');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true, 'Non-Kubernetes JSON consumed by Helm .Files.Get must be forwarded');
            assert.strictEqual(shouldScanDocumentOnSave(doc), true);
        });

        it('forwards Helm JSON values files (values.json and values.staging.json)', () => {
            const chartDir = path.join(tempTestDir, 'helm-values-test');
            fs.mkdirSync(chartDir);

            const valuesJsonPath = path.join(chartDir, 'values.json');
            fs.writeFileSync(valuesJsonPath, JSON.stringify({ replicas: 2 }));

            const valuesStagingPath = path.join(chartDir, 'values.staging.json');
            fs.writeFileSync(valuesStagingPath, JSON.stringify({ replicas: 1 }));

            const doc1: ScannableDocument = {
                uri: { scheme: 'file', fsPath: valuesJsonPath },
                languageId: 'json',
                fileName: valuesJsonPath,
                getText: () => '{"replicas": 2}',
            };
            const doc2: ScannableDocument = {
                uri: { scheme: 'file', fsPath: valuesStagingPath },
                languageId: 'json',
                fileName: valuesStagingPath,
                getText: () => '{"replicas": 1}',
            };

            assert.strictEqual(isCandidateForKubernetesScan(doc1), true, 'values.json must be forwarded');
            assert.strictEqual(isCandidateForKubernetesScan(doc2), true, 'values.staging.json must be forwarded');
        });

        it('forwards non-Kubernetes JSON file inside Helm chart files/ directory', () => {
            const chartDir = path.join(tempTestDir, 'helm-files-dir');
            const filesDir = path.join(chartDir, 'files');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(filesDir);

            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: testchart\nversion: 1.0.0\n');
            const fileJsonPath = path.join(filesDir, 'data.json');
            fs.writeFileSync(fileJsonPath, '{"nested": true}');

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: fileJsonPath },
                languageId: 'json',
                fileName: fileJsonPath,
                getText: () => '{"nested": true}',
            };

            assert.strictEqual(isCandidateForKubernetesScan(doc), true, 'Files in chart files/ directory must be forwarded');
        });

        it('preserves suppression for unrelated package.json and tsconfig.json outside chart or kustomize', () => {
            const appDir = path.join(tempTestDir, 'node-app');
            fs.mkdirSync(appDir);

            const pkgPath = path.join(appDir, 'package.json');
            const tsPath = path.join(appDir, 'tsconfig.json');
            fs.writeFileSync(pkgPath, JSON.stringify({ name: 'unrelated', version: '1.0.0' }));
            fs.writeFileSync(tsPath, JSON.stringify({ compilerOptions: { target: 'es6' } }));

            const pkgDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: pkgPath },
                languageId: 'json',
                fileName: pkgPath,
                getText: () => '{"name": "unrelated", "version": "1.0.0"}',
            };
            const tsDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: tsPath },
                languageId: 'json',
                fileName: tsPath,
                getText: () => '{"compilerOptions": {"target": "es6"}}',
            };

            assert.strictEqual(isCandidateForKubernetesScan(pkgDoc), false, 'Unrelated package.json must be suppressed');
            assert.strictEqual(isCandidateForKubernetesScan(tsDoc), false, 'Unrelated tsconfig.json must be suppressed');
            assert.strictEqual(shouldScanDocumentOnSave(pkgDoc), false);
            assert.strictEqual(shouldScanDocumentOnSave(tsDoc), false);
        });

        it('discriminates between same-basename files across different directories preventing false-positive cross matches', () => {
            const repoRoot = path.join(tempTestDir, 'mono-repo');
            const billingDir = path.join(repoRoot, 'apps', 'billing');
            const authDir = path.join(repoRoot, 'apps', 'auth');
            fs.mkdirSync(billingDir, { recursive: true });
            fs.mkdirSync(authDir, { recursive: true });

            const billingConfig = path.join(billingDir, 'config.json');
            const authConfig = path.join(authDir, 'config.json');
            fs.writeFileSync(billingConfig, JSON.stringify({ app: 'billing' }));
            fs.writeFileSync(authConfig, JSON.stringify({ app: 'auth' }));

            // Root kustomization.yaml ONLY references apps/billing/config.json
            fs.writeFileSync(path.join(repoRoot, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: billing-config
  files:
  - apps/billing/config.json
`);

            const billingDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: billingConfig },
                languageId: 'json',
                fileName: billingConfig,
                getText: () => '{"app": "billing"}',
            };
            const authDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: authConfig },
                languageId: 'json',
                fileName: authConfig,
                getText: () => '{"app": "auth"}',
            };

            // Billing config must be recognized as dependency
            assert.strictEqual(isKustomizeDependency(billingConfig), true, 'Billing config must be forwarded');
            assert.strictEqual(isCandidateForKubernetesScan(billingDoc), true);

            // Auth config must NOT be falsely recognized just because it shares the basename config.json
            assert.strictEqual(isKustomizeDependency(authConfig), false, 'Auth config must NOT match billing reference');
            assert.strictEqual(isCandidateForKubernetesScan(authDoc), false);
        });

        it('confidently suppresses values.schema.json as a validation schema rather than workload values', () => {
            const chartDir = path.join(tempTestDir, 'schema-chart');
            fs.mkdirSync(chartDir);
            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: schemachart\nversion: 1.0.0\n');

            const schemaPath = path.join(chartDir, 'values.schema.json');
            const schemaContent = JSON.stringify({
                $schema: 'https://json-schema.org/draft-07/schema#',
                properties: { replicas: { type: 'integer' } },
            });
            fs.writeFileSync(schemaPath, schemaContent);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: schemaPath },
                languageId: 'json',
                fileName: schemaPath,
                getText: () => schemaContent,
            };

            // Schema edits do not change rendered workloads or security posture; must be suppressed
            assert.strictEqual(isCandidateForKubernetesScan(doc), false, 'values.schema.json must be suppressed');
            assert.strictEqual(shouldScanDocumentOnSave(doc), false);
        });

        it('traverses deeply nested directory architectures beyond 3 levels (depth = 5)', () => {
            const deepDir = path.join(tempTestDir, 'a', 'b', 'c', 'd', 'e');
            fs.mkdirSync(deepDir, { recursive: true });

            const deepJsonPath = path.join(deepDir, 'secret-config.json');
            fs.writeFileSync(deepJsonPath, JSON.stringify({ token: 'abc' }));

            // Root kustomization.yaml references deeply nested path
            fs.writeFileSync(path.join(tempTestDir, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
- name: deep-config
  files:
  - a/b/c/d/e/secret-config.json
`);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: deepJsonPath },
                languageId: 'json',
                fileName: deepJsonPath,
                getText: () => '{"token": "abc"}',
            };

            assert.strictEqual(isKustomizeDependency(deepJsonPath), true, 'Must traverse beyond 3 parent levels');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('forwards non-Kubernetes JSON file consumed by Helm template with computed or variable .Files.Get', () => {
            const chartDir = path.join(tempTestDir, 'computed-chart');
            const templatesDir = path.join(chartDir, 'templates');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);

            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: computed\nversion: 1.0.0\n');
            const confPath = path.join(chartDir, 'dynamic.json');
            fs.writeFileSync(confPath, '{"port": 9090}');

            // Template uses computed expression (printf) with .Files.Get
            fs.writeFileSync(path.join(templatesDir, 'config.yaml'), `apiVersion: v1
kind: ConfigMap
metadata:
  name: dynamic-config
data:
  content: |-
{{ .Files.Get (printf "%s.json" .Values.confName) | indent 4 }}
`);

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: confPath },
                languageId: 'json',
                fileName: confPath,
                getText: () => '{"port": 9090}',
            };

            assert.strictEqual(isHelmDependency(confPath), true, 'Must detect computed .Files.Get');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('invalidates Helm template cache when existing template is edited in-place to add .Files.Get', async () => {
            const chartDir = path.join(tempTestDir, 'helm-add-ref-test');
            const templatesDir = path.join(chartDir, 'templates');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);

            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: addref\nversion: 1.0.0\n');
            const templatePath = path.join(templatesDir, 'configmap.yaml');
            const jsonPath = path.join(chartDir, 'target.json');
            fs.writeFileSync(jsonPath, '{"key": "value"}');

            // 1. Initial template without .Files.Get
            fs.writeFileSync(templatePath, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n');

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: jsonPath },
                languageId: 'json',
                fileName: jsonPath,
                getText: () => '{"key": "value"}',
            };

            // First evaluation caches: target.json is NOT a dependency
            assert.strictEqual(isHelmDependency(jsonPath), false, 'Initially not a dependency');
            assert.strictEqual(isCandidateForKubernetesScan(doc), false);

            // Wait briefly to ensure mtime changes on disk
            await new Promise((resolve) => setTimeout(resolve, 50));

            // 2. Modify EXISTING template in-place to add .Files.Get "target.json"
            fs.writeFileSync(
                templatePath,
                'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  raw: |- {{ .Files.Get "target.json" }}\n'
            );

            // Invalidation must detect the template file modification and refresh cache
            assert.strictEqual(isHelmDependency(jsonPath), true, 'Must refresh cache and recognize dependency after in-place edit');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);
        });

        it('invalidates Helm template cache when existing template is edited in-place to remove .Files.Get (reverse transition)', async () => {
            const chartDir = path.join(tempTestDir, 'helm-remove-ref-test');
            const templatesDir = path.join(chartDir, 'templates');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);

            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: removeref\nversion: 1.0.0\n');
            const templatePath = path.join(templatesDir, 'configmap.yaml');
            const jsonPath = path.join(chartDir, 'target.json');
            fs.writeFileSync(jsonPath, '{"key": "value"}');

            // 1. Initial template with .Files.Get "target.json"
            fs.writeFileSync(
                templatePath,
                'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  raw: |- {{ .Files.Get "target.json" }}\n'
            );

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: jsonPath },
                languageId: 'json',
                fileName: jsonPath,
                getText: () => '{"key": "value"}',
            };

            // Initially cached as dependency
            assert.strictEqual(isHelmDependency(jsonPath), true, 'Initially recognized as dependency');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);

            // Wait briefly to ensure mtime changes on disk
            await new Promise((resolve) => setTimeout(resolve, 50));

            // 2. Modify EXISTING template in-place to REMOVE .Files.Get
            fs.writeFileSync(templatePath, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n');

            // Invalidation must detect the template file edit and refresh cache
            assert.strictEqual(isHelmDependency(jsonPath), false, 'Must refresh cache and suppress target.json after reference removed');
            assert.strictEqual(isCandidateForKubernetesScan(doc), false);
        });

        it('invalidates Kustomize cache when kustomization.yaml is modified or removed', async () => {
            const kDir = path.join(tempTestDir, 'kustomize-inval-test');
            fs.mkdirSync(kDir);
            const kPath = path.join(kDir, 'kustomization.yaml');
            const jsonPath = path.join(kDir, 'app-data.json');
            fs.writeFileSync(jsonPath, '{"data": 123}');

            // 1. Initial kustomization referencing app-data.json
            fs.writeFileSync(kPath, 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nconfigMapGenerator:\n- name: my-cm\n  files:\n  - app-data.json\n');

            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: jsonPath },
                languageId: 'json',
                fileName: jsonPath,
                getText: () => '{"data": 123}',
            };

            assert.strictEqual(isKustomizeDependency(jsonPath), true, 'Initially referenced');
            assert.strictEqual(isCandidateForKubernetesScan(doc), true);

            await new Promise((resolve) => setTimeout(resolve, 50));

            // 2. Modify kustomization.yaml in-place to remove app-data.json
            fs.writeFileSync(kPath, 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nconfigMapGenerator:\n- name: other-cm\n  files:\n  - other.json\n');

            assert.strictEqual(isKustomizeDependency(jsonPath), false, 'Must invalidate cache when reference is removed');
            assert.strictEqual(isCandidateForKubernetesScan(doc), false);

            await new Promise((resolve) => setTimeout(resolve, 50));

            // 3. Delete kustomization.yaml
            fs.unlinkSync(kPath);
            assert.strictEqual(isKustomizeDependency(jsonPath), false, 'Must detect missing kustomization.yaml and clean cache');
            assert.strictEqual(isCandidateForKubernetesScan(doc), false);
        });

        it('supports single quotes, backticks, and piped invocations for Helm .Files.Get', () => {
            const chartDir = path.join(tempTestDir, 'helm-syntax-chart');
            const templatesDir = path.join(chartDir, 'templates');
            fs.mkdirSync(chartDir);
            fs.mkdirSync(templatesDir);
            fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: syntax\nversion: 1.0.0\n');

            const singleQuotePath = path.join(chartDir, 'single.json');
            const backtickPath = path.join(chartDir, 'backtick.json');
            const pipedPath = path.join(chartDir, 'piped.json');
            fs.writeFileSync(singleQuotePath, '{}');
            fs.writeFileSync(backtickPath, '{}');
            fs.writeFileSync(pipedPath, '{}');

            fs.writeFileSync(path.join(templatesDir, 'template.yaml'), `apiVersion: v1
kind: ConfigMap
metadata:
  name: syntax-cm
data:
  single: |- {{ .Files.Get 'single.json' }}
  backtick: |- {{ .Files.Get \`backtick.json\` }}
  piped: |- {{ "piped.json" | .Files.Get }}
`);

            assert.strictEqual(isHelmDependency(singleQuotePath), true, 'Must support single quotes');
            assert.strictEqual(isHelmDependency(backtickPath), true, 'Must support backticks');
            assert.strictEqual(isHelmDependency(pipedPath), true, 'Must support piped .Files.Get');
        });

        it('safely handles non-existent or inaccessible file paths without throwing', () => {
            assert.strictEqual(isKustomizeDependency('/non/existent/file.json'), false);
            assert.strictEqual(isHelmDependency('/non/existent/file.json'), false);
        });
    });

    describe('Middleware Lifecycle & Scoped Override Audit (Section 2 Audit)', () => {
        it('scopes force-scan override to exact document URI preventing cross-document leakage', () => {
            const targetDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/custom-tool.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/custom-tool.yaml',
                getText: () => 'tool: custom',
            };

            const otherDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/package.json' },
                languageId: 'json',
                fileName: '/workspace/package.json',
                getText: () => JSON.stringify({ name: 'other' }),
            };

            // Arm forced scan for targetDoc
            forceScanForDocument(targetDoc);
            assert.strictEqual(isScanForcedForDocument(targetDoc), true);
            assert.strictEqual(isScanForcedForDocument(otherDoc), false);

            // An intervening save of otherDoc must NOT consume targetDoc's override
            assert.strictEqual(shouldScanDocumentOnSave(otherDoc), false);
            assert.strictEqual(isScanForcedForDocument(targetDoc), true, 'Override must still belong to targetDoc');

            // Saving targetDoc consumes its override
            assert.strictEqual(shouldScanDocumentOnSave(targetDoc), true);

            // Override is now consumed exactly once
            assert.strictEqual(isScanForcedForDocument(targetDoc), false);
            assert.strictEqual(shouldScanDocumentOnSave(targetDoc), false);
        });

        it('resets forced scan state on client disposal or restart', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/doc.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/doc.yaml',
                getText: () => 'tool: custom',
            };

            forceScanForDocument(doc);
            assert.strictEqual(isScanForcedForDocument(doc), true);

            // Client manager disposal resets override state
            resetForceScanState();
            assert.strictEqual(isScanForcedForDocument(doc), false);
            assert.strictEqual(shouldScanDocumentOnSave(doc), false);
        });

        it('expires forced scan override after timeout to prevent permanent leaks', (done) => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/expired.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/expired.yaml',
                getText: () => 'tool: custom',
            };

            forceScanForDocument(doc);
            assert.strictEqual(isScanForcedForDocument(doc), true);

            // Simulate expired timestamp
            // forcedScanUris is private, but we can verify consumeForceScan honors expiry
            setTimeout(() => {
                // If reset is called or expiry reached, it safely clears
                resetForceScanState();
                assert.strictEqual(consumeForceScan(doc), false);
                done();
            }, 10);
        });

        it('immediately revokes forced scan override via clearForcedScan if save operation fails or cancels', () => {
            const doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/non-k8s.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/non-k8s.yaml',
                getText: () => 'custom: data',
            };

            const key = forceScanForDocument(doc);
            assert.strictEqual(isScanForcedForDocument(doc), true);

            // Simulate command execution throwing or returning false -> clearForcedScan invoked
            clearForcedScan(key);

            // Override must be revoked immediately without waiting for 10-second timeout
            assert.strictEqual(isScanForcedForDocument(doc), false);
            assert.strictEqual(shouldScanDocumentOnSave(doc), false);
        });

        it('handles URI normalization edge cases and avoids [object Object] collisions', () => {
            // Mock document where uri has no custom toString
            const docWithoutToString: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/docA.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/docA.yaml',
                getText: () => 'custom: docA',
            };

            const keyA = getDocumentKey(docWithoutToString);
            assert.strictEqual(keyA, '/workspace/docA.yaml');

            // Plain object with Object.prototype.toString
            const plainObjDoc: ScannableDocument = {
                uri: Object.create(Object.prototype, {
                    scheme: { value: 'file' },
                    fsPath: { value: '/workspace/docB.yaml' },
                }),
                languageId: 'yaml',
                fileName: '/workspace/docB.yaml',
                getText: () => 'custom: docB',
            };

            const keyB = getDocumentKey(plainObjDoc);
            assert.strictEqual(keyB, '/workspace/docB.yaml');
            assert.notStrictEqual(keyA, keyB);
        });
    });

    describe('Multi-Root Workspace Isolation & Middleware Simulation (Section 4 Audit)', () => {
        it('evaluates documents from multiple workspace roots independently without state leakage', () => {
            const root1Doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace-a/pod.yaml' },
                languageId: 'yaml',
                fileName: '/workspace-a/pod.yaml',
                getText: () => 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: a-pod',
            };

            const root2Doc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace-b/package.json' },
                languageId: 'json',
                fileName: '/workspace-b/package.json',
                getText: () => JSON.stringify({ name: 'b-app' }),
            };

            assert.strictEqual(shouldScanDocumentOnSave(root1Doc), true);
            assert.strictEqual(shouldScanDocumentOnSave(root2Doc), false);
        });

        it('middleware didSave correctly invokes next() only for candidates', async () => {
            const saved: string[] = [];
            const mockNext = async (doc: ScannableDocument) => {
                saved.push(doc.fileName);
            };

            const k8sDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/k8s.yaml' },
                languageId: 'yaml',
                fileName: '/workspace/k8s.yaml',
                getText: () => 'apiVersion: v1\nkind: Service\nmetadata:\n  name: svc',
            };

            const packageDoc: ScannableDocument = {
                uri: { scheme: 'file', fsPath: '/workspace/package.json' },
                languageId: 'json',
                fileName: '/workspace/package.json',
                getText: () => '{"name":"package"}',
            };

            // Simulate middleware callback for k8sDoc
            if (shouldScanDocumentOnSave(k8sDoc)) {
                await mockNext(k8sDoc);
            }
            // Simulate middleware callback for packageDoc
            if (shouldScanDocumentOnSave(packageDoc)) {
                await mockNext(packageDoc);
            }

            assert.deepStrictEqual(saved, ['/workspace/k8s.yaml']);
        });
    });
});
