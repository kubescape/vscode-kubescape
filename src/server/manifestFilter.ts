import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Minimal interface representing the parts of vscode.TextDocument required
 * for save-time manifest filtering.
 */
export interface ScannableDocument {
    readonly uri: { scheme: string; fsPath?: string; path?: string; toString?(): string };
    readonly languageId: string;
    readonly fileName: string;
    getText(): string;
}

/**
 * Known filenames that belong to Kustomize or Helm configuration and directly
 * affect Kubernetes scan evaluation.
 */
export const KUSTOMIZE_FILENAMES = new Set([
    'kustomization.yaml',
    'kustomization.yml',
    'Kustomization',
]);

export const HELM_FILENAMES = new Set([
    'chart.yaml',
    'chart.yml',
    'values.yaml',
    'values.yml',
    'values.json',
]);

/**
 * Known file patterns and directories that are tool configurations.
 * Note: These exclusions are only applied when the document LACKS strong
 * Kubernetes evidence. Strong Kubernetes evidence always overrides these exclusions.
 */
const KNOWN_NON_K8S_FILENAMES = new Set([
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'composer.json',
    'composer.lock',
    'tsconfig.json',
    'jsconfig.json',
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml',
    '.pre-commit-config.yaml',
    '.gitlab-ci.yml',
    '.gitlab-ci.yaml',
    '.travis.yml',
    'lerna.json',
    'turbo.json',
    'nx.json',
]);

/**
 * Injectable clock for controlled timing and expiration testing.
 */
export type TimeProvider = () => number;
let timeProvider: TimeProvider = () => Date.now();

export function setTimeProvider(provider: TimeProvider): void {
    timeProvider = provider;
}

export function resetTimeProvider(): void {
    timeProvider = () => Date.now();
}

/**
 * Handle representing an active manual save attempt.
 */
export interface ForcedScanHandle {
    readonly token: string;
    readonly key: string;
    readonly ownerId?: string;
    readonly isActive: boolean;
    readonly isConsumed: boolean;
    revoke(): void;
    complete(): void;
}

/**
 * Represents an active or unmanaged manual save override attempt.
 */
export interface ForcedScanAttempt {
    readonly token: string;
    readonly uriKey: string;
    readonly ownerId?: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    isActive: boolean;
    isConsumed: boolean;
}

/**
 * URI-scoped forced scans mapped by canonical URI key.
 * Modeled around a state-based lifecycle: active attempts cannot expire merely
 * due to elapsed time, while unmanaged/abandoned attempts expire safely.
 */
const forcedScanAttempts = new Map<string, ForcedScanAttempt>();
export const DEFAULT_ABANDONED_TIMEOUT_MS = 60000; // 60s safety timeout to clean up abandoned attempts

/**
 * Normalizes document URI to a canonical string key.
 */
export function getDocumentKey(docOrUri: ScannableDocument | string): string {
    if (!docOrUri) {
        return '';
    }
    if (typeof docOrUri === 'string') {
        return docOrUri.trim().replace(/\\/g, '/');
    }
    const uri = docOrUri.uri;
    if (uri && typeof uri.toString === 'function' && uri.toString !== Object.prototype.toString) {
        const str = uri.toString();
        if (str && str !== '[object Object]') {
            return str;
        }
    }
    const rawPath = docOrUri.fileName || uri?.fsPath || uri?.path || '';
    return rawPath.replace(/\\/g, '/');
}

/**
 * Arms an active manual save attempt with a state-based lifecycle.
 * While the attempt remains active (held by the caller during saveToTriggerScan),
 * elapsed time alone CANNOT invalidate it, ensuring slow formatters or remote filesystems
 * never lose the override. When the attempt ends, calling complete() or revoke() cleans it up.
 */
export function armForcedScan(
    docOrUri: ScannableDocument | string,
    ownerId?: string,
    abandonedTimeoutMs: number = DEFAULT_ABANDONED_TIMEOUT_MS
): ForcedScanHandle {
    const key = getDocumentKey(docOrUri);
    if (!key) {
        return {
            token: '',
            key: '',
            isActive: false,
            isConsumed: false,
            revoke: () => {},
            complete: () => {},
        };
    }
    const token = crypto.randomBytes(8).toString('hex');
    const now = timeProvider();
    const attempt: ForcedScanAttempt = {
        token,
        uriKey: key,
        ownerId,
        createdAt: now,
        expiresAt: now + abandonedTimeoutMs,
        isActive: true, // Marked active: cannot expire due to elapsed time while active
        isConsumed: false,
    };
    forcedScanAttempts.set(key, attempt);

    return {
        token,
        key,
        ownerId,
        get isActive() {
            return attempt.isActive;
        },
        get isConsumed() {
            return attempt.isConsumed;
        },
        revoke() {
            attempt.isActive = false;
            forcedScanAttempts.delete(key);
        },
        complete() {
            attempt.isActive = false;
            if (!attempt.isConsumed) {
                forcedScanAttempts.delete(key);
            }
        },
    };
}

/**
 * Arms an unmanaged forced scan override.
 * Unmanaged attempts are subject to the abandoned timeout and clean up automatically.
 */
export function forceScanForDocument(
    docOrUri: ScannableDocument | string,
    ownerId?: string,
    timeoutMs: number = DEFAULT_ABANDONED_TIMEOUT_MS
): string {
    const key = getDocumentKey(docOrUri);
    if (!key) {
        return '';
    }
    const token = crypto.randomBytes(8).toString('hex');
    const now = timeProvider();
    const attempt: ForcedScanAttempt = {
        token,
        uriKey: key,
        ownerId,
        createdAt: now,
        expiresAt: now + timeoutMs,
        isActive: false, // unmanaged: will expire after timeoutMs
        isConsumed: false,
    };
    forcedScanAttempts.set(key, attempt);
    return key;
}

/**
 * Revokes a pending forced scan override for a document (e.g. if a save command failed or cancelled).
 */
export function clearForcedScan(keyOrDoc: ScannableDocument | string): void {
    const key = getDocumentKey(keyOrDoc);
    if (key) {
        const attempt = forcedScanAttempts.get(key);
        if (attempt) {
            attempt.isActive = false;
            forcedScanAttempts.delete(key);
        }
    }
}

/**
 * Clears pending forced scans belonging to a specific owner/client.
 * Ensures a retiring client's pending state is purged without disturbing other clients' attempts.
 */
export function clearForcedScansForOwner(ownerId: string): void {
    if (!ownerId) {
        return;
    }
    for (const [key, attempt] of forcedScanAttempts.entries()) {
        if (attempt.ownerId === ownerId) {
            attempt.isActive = false;
            forcedScanAttempts.delete(key);
        }
    }
}

/**
 * Consumes the forced scan override for a specific document if active, matching owner, and unexpired.
 * Consumed strictly once.
 */
export function consumeForceScan(docOrUri: ScannableDocument | string, ownerId?: string): boolean {
    const key = getDocumentKey(docOrUri);
    if (!key) {
        return false;
    }
    const attempt = forcedScanAttempts.get(key);
    if (!attempt) {
        return false;
    }
    if (ownerId && attempt.ownerId && attempt.ownerId !== ownerId) {
        return false;
    }

    // 1. If the attempt is actively in progress, elapsed time alone CANNOT invalidate it!
    if (attempt.isActive) {
        attempt.isConsumed = true;
        attempt.isActive = false;
        forcedScanAttempts.delete(key);
        return true;
    }

    // 2. Unmanaged / inactive attempt: subject to abandoned timeout
    forcedScanAttempts.delete(key);
    return timeProvider() <= attempt.expiresAt;
}

/**
 * Resets all forced scan overrides and internal caches. Called on client restart and extension deactivation.
 */
export function resetForceScanState(): void {
    forcedScanAttempts.clear();
    kustomizeCache.clear();
    helmChartCache.clear();
    templateFileCache.clear();
}

/**
 * Returns whether a forced scan override is currently pending for a document.
 */
export function isScanForcedForDocument(docOrUri: ScannableDocument | string, ownerId?: string): boolean {
    const key = getDocumentKey(docOrUri);
    if (!key) {
        return false;
    }
    const attempt = forcedScanAttempts.get(key);
    if (!attempt) {
        return false;
    }
    if (ownerId && attempt.ownerId && attempt.ownerId !== ownerId) {
        return false;
    }
    // Active attempt is always valid regardless of elapsed time
    if (attempt.isActive) {
        return true;
    }
    // Unmanaged attempt expires after abandoned timeout
    if (timeProvider() > attempt.expiresAt) {
        forcedScanAttempts.delete(key);
        return false;
    }
    return true;
}

/**
 * Evaluates whether a saved document should trigger a Kubescape workspace scan.
 * Explicit commands always trigger scans; automatic saves are filtered to ensure
 * only Kubernetes manifests and Helm/Kustomize files trigger scans.
 *
 * Follows the conservative rule: Never suppress a save unless the document is
 * confidently classified as non-Kubernetes. Uncertain/ambiguous files trigger scanning.
 */
export function shouldScanDocumentOnSave(document: ScannableDocument, ownerId?: string): boolean {
    if (consumeForceScan(document, ownerId)) {
        return true;
    }
    return isCandidateForKubernetesScan(document);
}

/**
 * Creates the production didSave middleware for the Kubescape Language Client.
 * Filters non-candidate saves while forwarding manifests and indirect dependencies.
 */
export function createDidSaveMiddleware<T extends ScannableDocument = ScannableDocument>(
    filter: (doc: ScannableDocument) => boolean = shouldScanDocumentOnSave,
    outputChannel?: { appendLine(msg: string): void }
): (data: T, next: (data: T) => Promise<void>) => Promise<void> {
    return async (data: T, next: (data: T) => Promise<void>) => {
        const shouldScan = filter(data);
        if (shouldScan) {
            return next(data);
        }
        outputChannel?.appendLine(
            `[LSP Scoped Scan] Skipping save-time workspace scan: document "${data.fileName}" contains no Kubernetes manifests or configurations.`
        );
    };
}

/**
 * Inspects a document on save to determine whether it is a candidate for a
 * Kubescape security scan.
 *
 * Core principles:
 * 1. Strong Kubernetes evidence (apiVersion + kind, Helm templates, Kustomize) ALWAYS wins.
 *    Explicit exclusions (like .github/workflows/ or docker-compose.yaml) NEVER override
 *    strong Kubernetes evidence.
 * 2. Ambiguous YAML files that cannot be confidently classified as non-Kubernetes are forwarded.
 * 3. Only files that lack strong Kubernetes evidence AND match known non-Kubernetes tools/formats
 *    are suppressed.
 */
export function isCandidateForKubernetesScan(document: ScannableDocument): boolean {
    if (!document) {
        return false;
    }

    // Only real local files on disk can be scanned by the local scanner
    if (document.uri?.scheme !== 'file') {
        return false;
    }

    const filePath = (document.fileName || document.uri.fsPath || document.uri.path || '').replace(/\\/g, '/');
    const basename = path.basename(filePath);
    const lowerBasename = basename.toLowerCase();

    // 1. Kustomize configuration files directly define or compose Kubernetes resources
    if (KUSTOMIZE_FILENAMES.has(basename) || KUSTOMIZE_FILENAMES.has(lowerBasename)) {
        return true;
    }

    // 2. Helm chart metadata and values files directly influence template rendering (YAML or JSON)
    // Note: values.schema.json is a validation schema, not a workload values file, and is excluded.
    if (lowerBasename !== 'values.schema.json') {
        if (HELM_FILENAMES.has(lowerBasename) || (lowerBasename.startsWith('values.') && (lowerBasename.endsWith('.yaml') || lowerBasename.endsWith('.yml') || lowerBasename.endsWith('.json')))) {
            return true;
        }
    }

    // 3. Files inside a Helm templates/ directory
    if (filePath.includes('/templates/') && (lowerBasename.endsWith('.yaml') || lowerBasename.endsWith('.yml') || lowerBasename.endsWith('.tpl'))) {
        return true;
    }

    // 4. Must match supported languages (YAML or JSON)
    const lang = document.languageId;
    const isYaml = lang === 'yaml' || lowerBasename.endsWith('.yaml') || lowerBasename.endsWith('.yml');
    const isJson = lang === 'json' || lowerBasename.endsWith('.json');

    if (!isYaml && !isJson) {
        return false;
    }

    // Check document content
    const text = document.getText();
    if (!text || text.trim().length === 0) {
        // An empty file referenced by a generator or Helm template can still affect rendered resources
        return isKustomizeDependency(filePath) || isHelmDependency(filePath);
    }

    // 5. Strong Kubernetes Evidence Check (Checked BEFORE exclusions!)
    // If a document contains strong Kubernetes evidence, it MUST be forwarded,
    // even if it is stored in a directory like .github/workflows/ or named docker-compose.yaml.
    if (isJson) {
        const jsonEvidence = checkKubernetesJsonEvidence(text);
        if (jsonEvidence === 'strong_k8s') {
            return true;
        }
        // Indirect dependency checks:
        // A. Kustomize configuration referencing this JSON file (e.g. in configMapGenerator/secretGenerator)
        if (isKustomizeDependency(filePath)) {
            return true;
        }
        // B. Helm template consuming this JSON file (e.g. via .Files.Get / in chart files/)
        if (isHelmDependency(filePath)) {
            return true;
        }
        if (jsonEvidence === 'confident_non_k8s') {
            return false;
        }
        // Ambiguous JSON: check if path is excluded
        if (isKnownNonKubernetesPath(filePath, lowerBasename)) {
            return false;
        }
        return true;
    }

    const yamlEvidence = checkKubernetesYamlEvidence(text);
    if (yamlEvidence === 'strong_k8s') {
        // Strong Kubernetes evidence ALWAYS overrides known-path exclusions
        return true;
    }

    // Indirect dependency checks for YAML files lacking direct apiVersion/kind:
    if (isKustomizeDependency(filePath)) {
        return true;
    }
    if (isHelmDependency(filePath)) {
        return true;
    }

    // 6. If the file lacks strong Kubernetes evidence and is not an indirect dependency, check known exclusions
    if (isKnownNonKubernetesPath(filePath, lowerBasename)) {
        return false;
    }

    // 7. For other YAML files:
    // If it has partial Kubernetes indicators (ambiguous) -> forward under conservative policy
    if (yamlEvidence === 'ambiguous_k8s') {
        return true;
    }

    // Confidently non-Kubernetes YAML (no apiVersion, no kind, no templates, no metadata/spec)
    return false;
}

/**
 * Extracts referenced file paths from a Kustomize configuration.
 * Handles generators (files, envs), resources, patches, and component lists.
 * Normalizes all paths relative to the kustomization directory and ignores URL schemes.
 */
export function extractKustomizeReferences(content: string): Set<string> {
    const refs = new Set<string>();
    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
        const commentIdx = rawLine.indexOf('#');
        const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim();
        if (!line) {
            continue;
        }

        const candidateTokens: string[] = [];

        // Match list items, e.g. - "foo.json" or - foo.json
        const listMatch = line.match(/^-\s+(.+)$/);
        if (listMatch) {
            candidateTokens.push(listMatch[1].trim());
        }

        // Match property assignments, e.g. path: foo.json
        const propMatch = line.match(/^\w+:\s*(.+)$/);
        if (propMatch) {
            candidateTokens.push(propMatch[1].trim());
        }

        // Match inline array elements [ ... ]
        const bracketMatch = line.match(/\[(.*)\]/);
        if (bracketMatch) {
            for (const item of bracketMatch[1].split(',')) {
                candidateTokens.push(item.trim());
            }
        }

        for (let token of candidateTokens) {
            token = token.replace(/^["']|["']$/g, '').trim();
            if (!token) {
                continue;
            }
            // Handle key=path syntax, e.g. config-key=sub/config.json
            const eqIdx = token.indexOf('=');
            if (eqIdx >= 0) {
                token = token.slice(eqIdx + 1).replace(/^["']|["']$/g, '').trim();
            }
            if (token && !token.startsWith('http://') && !token.startsWith('https://')) {
                // Normalize posix path: collapses '//', resolves './', etc.
                const normalized = path.posix.normalize(token.replace(/\\/g, '/')).replace(/^\.\//, '');
                refs.add(normalized);
            }
        }
    }
    return refs;
}

/**
 * Maximum directory traversal depth when searching upward for Kustomize or Helm root.
 * Bounded to 8 levels to cover deep enterprise repos in O(1) time without runaway walking.
 */
const MAX_SEARCH_DEPTH = 8;

interface KustomizeCacheEntry {
    contentHash: string;
    references: Set<string>;
}

interface TemplateAnalysis {
    usesGlobOrComputed: boolean;
    literals: Set<string>;
}

interface TemplateFileCacheEntry {
    contentHash: string;
    analysis: TemplateAnalysis;
}

interface HelmChartCacheEntry {
    fingerprint: string;
    usesGlobOrComputed: boolean;
    literals: Set<string>;
}

const kustomizeCache = new Map<string, KustomizeCacheEntry>();
const helmChartCache = new Map<string, HelmChartCacheEntry>();
const templateFileCache = new Map<string, TemplateFileCacheEntry>();

/**
 * Computes a SHA-256 hash of a string buffer.
 */
function computeSha256(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Recursively locates template files inside a Helm templates directory.
 */
function findTemplateFiles(dir: string, depth = 0): string[] {
    if (depth > 3 || !fs.existsSync(dir)) {
        return [];
    }
    const results: string[] = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...findTemplateFiles(fullPath, depth + 1));
            } else if (entry.isFile()) {
                const lower = entry.name.toLowerCase();
                if (lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.tpl')) {
                    results.push(fullPath);
                }
            }
        }
    } catch {
        // Return whatever was collected safely
    }
    return results.sort();
}

/**
 * Analyzes a Helm template for static or dynamic .Files usages and aliases.
 * Distinguishes between static literals (double quotes, single quotes, backticks),
 * aliases (e.g. {{ $files := .Files }}), piped invocations, wildcard globbing,
 * and computed/variable expressions.
 */
export function analyzeHelmTemplate(content: string): TemplateAnalysis {
    if (!content.includes('.Files') && !/\$\w+\.(?:Get|GetBytes|Glob|Lines)\b/.test(content)) {
        return { usesGlobOrComputed: false, literals: new Set() };
    }

    let usesGlobOrComputed = false;
    const literals = new Set<string>();

    // 1. Detect .Files aliases: e.g. {{ $files := .Files }} or $f = .Files
    const hasFilesAlias = /\$\w+\s*:?=\s*\.Files\b/.test(content);
    if (hasFilesAlias) {
        usesGlobOrComputed = true;
    }

    // 2. Detect method calls on variables: e.g. $files.Get "..." or $f.GetBytes
    const variableCallRegex = /\$(\w+)\.(Get|GetBytes|Glob|Lines)\s*(?:\(?\s*["'`]([^"'`]+)["'`])?/g;
    let varMatch: RegExpExecArray | null;
    while ((varMatch = variableCallRegex.exec(content)) !== null) {
        usesGlobOrComputed = true;
        if (varMatch[3]) {
            const norm = path.posix.normalize(varMatch[3].replace(/\\/g, '/')).replace(/^\.\//, '');
            literals.add(norm);
        }
    }

    // 3. Detect .Files.Glob
    if (content.includes('.Files.Glob')) {
        usesGlobOrComputed = true;
    }

    // 4. Detect piped .Files invocations, e.g. "path" | .Files.Get
    if (/\|\s*\.Files\.(?:Get|GetBytes)/.test(content)) {
        usesGlobOrComputed = true;
    }

    // 5. Detect computed/variable arguments, e.g. .Files.Get $var or .Files.Get (printf ...)
    if (/\.Files\.(?:Get|GetBytes)\s*(\$|\(|\.[a-zA-Z]|[a-zA-Z])/.test(content)) {
        usesGlobOrComputed = true;
    }

    // 6. Direct literal references from .Files.Get / .Files.GetBytes
    const literalRegex = /\.Files\.(?:Get|GetBytes)\s*\(?\s*["'`]([^"'`]+)["'`]/g;
    let match: RegExpExecArray | null;
    while ((match = literalRegex.exec(content)) !== null) {
        const norm = path.posix.normalize(match[1].replace(/\\/g, '/')).replace(/^\.\//, '');
        literals.add(norm);
    }

    // 7. General .Files usage without direct methods or alias
    if (!hasFilesAlias && !content.includes('.Files.') && content.includes('.Files')) {
        usesGlobOrComputed = true;
    }

    return { usesGlobOrComputed, literals };
}

/**
 * Checks whether a JSON or YAML file is referenced by a Kustomize configuration
 * (e.g. in configMapGenerator, secretGenerator, resources, or patches) in its directory
 * or ancestor directories up to MAX_SEARCH_DEPTH levels.
 */
export function isKustomizeDependency(filePath: string): boolean {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return false;
        }
        let currentDir = path.dirname(filePath);

        for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth++) {
            for (const kFilename of KUSTOMIZE_FILENAMES) {
                const kPath = path.join(currentDir, kFilename);
                if (fs.existsSync(kPath)) {
                    let references: Set<string>;
                    try {
                        const content = fs.readFileSync(kPath, 'utf8');
                        const contentHash = computeSha256(content);
                        const cached = kustomizeCache.get(kPath);
                        if (cached && cached.contentHash === contentHash) {
                            references = cached.references;
                        } else {
                            references = extractKustomizeReferences(content);
                            if (kustomizeCache.size > 100) {
                                kustomizeCache.clear();
                            }
                            kustomizeCache.set(kPath, { contentHash, references });
                        }
                    } catch {
                        kustomizeCache.delete(kPath);
                        continue;
                    }

                    // Exact normalized relative path matching:
                    // Compares the target file's relative path from the kustomization root
                    // against complete normalized references in kustomization.yaml.
                    const targetRelPath = path.posix.normalize(path.relative(currentDir, filePath).replace(/\\/g, '/')).replace(/^\.\//, '');
                    if (references.has(targetRelPath)) {
                        return true;
                    }
                } else {
                    kustomizeCache.delete(kPath);
                }
            }
            const parent = path.dirname(currentDir);
            if (!parent || parent === currentDir) {
                break;
            }
            currentDir = parent;
        }
    } catch {
        // Safe fallback on filesystem or permission error
    }
    return false;
}

/**
 * Checks whether a JSON or YAML file is consumed by a Helm chart
 * (e.g. in values files, in the chart files/ directory, or referenced by templates via .Files.Get).
 */
export function isHelmDependency(filePath: string): boolean {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return false;
        }
        const basename = path.basename(filePath);
        const lowerBasename = basename.toLowerCase();

        // Direct Helm values files (YAML or JSON). values.schema.json is excluded as it is a schema.
        if (lowerBasename !== 'values.schema.json') {
            if (HELM_FILENAMES.has(lowerBasename) || (lowerBasename.startsWith('values.') && (lowerBasename.endsWith('.yaml') || lowerBasename.endsWith('.yml') || lowerBasename.endsWith('.json')))) {
                return true;
            }
        }

        let currentDir = path.dirname(filePath);

        // Search up to MAX_SEARCH_DEPTH levels for Helm chart root (Chart.yaml)
        for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth++) {
            const chartYamlPath = path.join(currentDir, 'Chart.yaml');
            const chartYmlPath = path.join(currentDir, 'Chart.yml');

            if (fs.existsSync(chartYamlPath) || fs.existsSync(chartYmlPath)) {
                const relPath = path.posix.normalize(path.relative(currentDir, filePath).replace(/\\/g, '/')).replace(/^\.\//, '');

                // Files in standard Helm `files/` directory are intended for .Files.Get
                if (relPath.startsWith('files/')) {
                    return true;
                }

                const templatesDir = path.join(currentDir, 'templates');
                if (fs.existsSync(templatesDir)) {
                    let chartInfo = helmChartCache.get(currentDir);
                    let hasReadErrors = false;

                    try {
                        const templateFiles = findTemplateFiles(templatesDir);
                        const templateHashes: string[] = [];
                        const analyses: TemplateAnalysis[] = [];

                        for (const tf of templateFiles) {
                            try {
                                const content = fs.readFileSync(tf, 'utf8');
                                const contentHash = computeSha256(content);
                                templateHashes.push(`${tf}:${contentHash}`);

                                const cachedAnalysis = templateFileCache.get(tf);
                                if (cachedAnalysis && cachedAnalysis.contentHash === contentHash) {
                                    analyses.push(cachedAnalysis.analysis);
                                } else {
                                    const analysis = analyzeHelmTemplate(content);
                                    if (templateFileCache.size > 200) {
                                        templateFileCache.clear();
                                    }
                                    templateFileCache.set(tf, { contentHash, analysis });
                                    analyses.push(analysis);
                                }
                            } catch {
                                hasReadErrors = true;
                            }
                        }

                        // If any template cannot be read, do not cache an incomplete negative result.
                        // Treat the chart as uncertain for this save and retry on later saves.
                        if (hasReadErrors) {
                            helmChartCache.delete(currentDir);
                            return true;
                        }

                        const fingerprint = templateHashes.join(';');

                        if (!chartInfo || chartInfo.fingerprint !== fingerprint) {
                            let usesGlobOrComputed = false;
                            const literals = new Set<string>();

                            for (const analysis of analyses) {
                                if (analysis.usesGlobOrComputed) {
                                    usesGlobOrComputed = true;
                                }
                                for (const lit of analysis.literals) {
                                    literals.add(lit);
                                }
                            }

                            chartInfo = { fingerprint, usesGlobOrComputed, literals };
                            if (helmChartCache.size > 100) {
                                helmChartCache.clear();
                            }
                            helmChartCache.set(currentDir, chartInfo);
                        }
                    } catch {
                        // On filesystem inspection errors, treat as uncertain without caching
                        return true;
                    }

                    if (chartInfo) {
                        if (chartInfo.usesGlobOrComputed) {
                            return true;
                        }
                        // Exact chart-relative path match (no basename fallback)
                        if (chartInfo.literals.has(relPath)) {
                            return true;
                        }
                    }
                }
                break;
            }

            const parent = path.dirname(currentDir);
            if (!parent || parent === currentDir) {
                break;
            }
            currentDir = parent;
        }
    } catch {
        // Safe fallback on any filesystem or permission error
    }
    return false;
}

/**
 * Checks whether the file path or filename corresponds to a known non-Kubernetes tool.
 */
function isKnownNonKubernetesPath(filePath: string, lowerBasename: string): boolean {
    if (KNOWN_NON_K8S_FILENAMES.has(lowerBasename)) {
        return true;
    }
    if (filePath.includes('/.github/workflows/') || filePath.includes('/.vscode/')) {
        return true;
    }
    return false;
}

type EvidenceLevel = 'strong_k8s' | 'ambiguous_k8s' | 'confident_non_k8s';

/**
 * Analyzes JSON content for Kubernetes resource structures.
 */
function checkKubernetesJsonEvidence(text: string): EvidenceLevel {
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null) {
            return 'confident_non_k8s';
        }
        if (Array.isArray(parsed)) {
            const hasK8s = parsed.some(item => item && typeof item === 'object' && typeof item.apiVersion === 'string' && typeof item.kind === 'string');
            return hasK8s ? 'strong_k8s' : 'confident_non_k8s';
        }
        // Standard Kubernetes resource
        if (typeof parsed.apiVersion === 'string' && typeof parsed.kind === 'string') {
            return 'strong_k8s';
        }
        // Kubernetes List envelope
        if (typeof parsed.apiVersion === 'string' && Array.isArray(parsed.items)) {
            return 'strong_k8s';
        }
        // Parsed cleanly without apiVersion/kind: confident non-Kubernetes JSON
        return 'confident_non_k8s';
    } catch {
        // Malformed JSON fallback regex
        const hasApiVersion = /"apiVersion"\s*:\s*["'][^"']+["']/i.test(text);
        const hasKind = /"kind"\s*:\s*["'][^"']+["']/i.test(text);
        if (hasApiVersion && hasKind) {
            return 'strong_k8s';
        }
        if (hasApiVersion || hasKind) {
            return 'ambiguous_k8s';
        }
        return 'confident_non_k8s';
    }
}

/**
 * Analyzes YAML content for Kubernetes resource structures.
 */
function checkKubernetesYamlEvidence(text: string): EvidenceLevel {
    // 1. Flexible regex matching apiVersion and kind (supports block YAML, flow mappings e.g. {apiVersion: ..., kind: ...}, quotes, inline comments, and whitespace)
    const hasApiVersion = /(?:^|\n|[,\{])\s*['"]?apiVersion['"]?\s*:\s*[^\s,#\}]+/im.test(text);
    const hasKind = /(?:^|\n|[,\{])\s*['"]?kind['"]?\s*:\s*[^\s,#\}]+/im.test(text);

    if (hasApiVersion && hasKind) {
        return 'strong_k8s';
    }

    // 2. Helm template delimiters are strong indicators of templated manifests,
    // excluding GitHub Actions / shell expressions like ${{ ... }}
    const textWithoutDollarBraces = text.replace(/\$\{\{[\s\S]*?\}\}/g, '');
    if (textWithoutDollarBraces.includes('{{') && textWithoutDollarBraces.includes('}}')) {
        return 'strong_k8s';
    }

    // 3. Ambiguous evidence: one of apiVersion/kind or Kubernetes-like metadata + spec
    if (hasApiVersion || hasKind) {
        return 'ambiguous_k8s';
    }

    const hasMetadata = /(?:^|\n)\s*['"]?metadata['"]?\s*:\s*(?:\n|\s+#)/im.test(text);
    const hasSpec = /(?:^|\n)\s*['"]?spec['"]?\s*:\s*(?:\n|\s+#)/im.test(text);
    if (hasMetadata && hasSpec) {
        return 'ambiguous_k8s';
    }

    return 'confident_non_k8s';
}
