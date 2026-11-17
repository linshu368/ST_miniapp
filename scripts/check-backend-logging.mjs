import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { inspectBoundaries } from './logging-boundary-checks.mjs';

const ts = createRequire(new URL('../packages/backend/package.json', import.meta.url))(
  'typescript'
);

// Transport primitives and offline import adapters are explicit exceptions, not per-file comments.
const rawFetchOwners = new Set([
  'platform/observability/fetch.ts',
  'platform/observability/fetch-core.ts',
  'features/alerting/feishu-alert-sink.ts', // Instrumenting notification delivery could recursively alert.
  'features/image-plaza/video-seed-import.ts', // Offline video importer; bounded redirects and proxy behavior have existing tests.
  'scripts/upload-video-plaza-seed-assets.ts', // Human-operated Storage uploader; preserves reviewed JSON/proxy protocol.
  'scripts/validate-video-plaza-seed-playback.ts', // Offline signed-URL Range validation, never a product request.
  'features/image-plaza/seed-import.ts', // Offline importer; proxy, limits and retries have their own tests.
]);

/** Parse value references, including aliases/defaults; merely importing a wrapper is insufficient. */
export function inspectLogging(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const problems = [];
  const clients = new Set();
  const observers = new Set();
  const rawNames = new Set(['fetch']);
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const module = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const item of bindings.elements) {
      const imported = (item.propertyName ?? item.name).text;
      if (module.endsWith('/observability/fetch.js')) {
        if (imported === 'clientFetch') clients.add(item.name.text);
        if (imported === 'observedFetch') observers.add(item.name.text);
      }
      if (module === 'undici' && imported === 'fetch') rawNames.add(item.name.text);
    }
    // Local fetch must actually be created by an imported clientFetch below.
  }
  function registeredFetch(node) {
    // A client in one block cannot exempt a raw fetch in another block or shadowed parameter.
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (
        ts.isFunctionLike(scope) &&
        scope.parameters.some((item) => item.name.getText(file) === 'fetch')
      )
        return false;
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
      const declaration = scope.statements
        .filter(ts.isVariableStatement)
        .flatMap((item) => [...item.declarationList.declarations])
        .find((item) => ts.isIdentifier(item.name) && item.name.text === 'fetch');
      if (declaration) {
        const call = declaration.initializer;
        return (
          call &&
          ts.isCallExpression(call) &&
          ts.isIdentifier(call.expression) &&
          clients.has(call.expression.text)
        );
      }
    }
    return false;
  }
  function withinObserver(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        ts.isCallExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        observers.has(parent.expression.text)
      )
        return true;
    }
    return false;
  }
  function globalFetch(node) {
    return (
      (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'globalThis' &&
        node.name.text === 'fetch') ||
      (ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'globalThis' &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === 'fetch')
    );
  }
  function reference(node) {
    const parent = node.parent;
    return !(
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isFunctionDeclaration(parent)) &&
        parent.name === node)
    );
  }
  function walk(node) {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      globalFetch(node.left) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
      problems.push('global fetch replacement is not allowed');
    const raw =
      globalFetch(node) ||
      (ts.isIdentifier(node) &&
        rawNames.has(node.text) &&
        reference(node) &&
        !(node.text === 'fetch' && registeredFetch(node)));
    const destructured =
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === 'globalThis' &&
      node.name.elements.some(
        (element) => (element.propertyName ?? element.name).getText(file) === 'fetch'
      );
    if ((raw || destructured) && !rawFetchOwners.has(path) && !withinObserver(node))
      problems.push('register the transport with observedFetch/clientFetch (including aliases)');
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'console' &&
        ['log', 'info', 'warn', 'error', 'debug'].includes(callee.name.text)
      )
        problems.push('use structured Pino/observation instead of console');
    }
    ts.forEachChild(node, walk);
  }
  walk(file);
  return [...new Set([...problems, ...inspectBoundaries(ts, file, path)])];
}

const root = 'packages/backend/src';
const offlineScripts = new Set([
  'translate-image-plaza-seed-prompts.ts',
  'story-memory-replay.ts',
  'railway-drama-report.ts',
  'payment-callback-report.ts',
  'import-image-plaza-seed.ts',
  // Video seed tools are offline human/JSON CLIs, matching the existing image importer.
  'estimate-video-plaza-seed-size.ts',
  'generate-video-plaza-seed-sql.ts',
  'import-video-plaza-seed.ts',
  'process-video-plaza-seed-assets.ts',
  'upload-video-plaza-seed-assets.ts',
  'validate-video-plaza-seed-playback.ts',
  'drama-survey-report.ts',
  'compare-drama-stream.ts',
  'compare-drama-startup-optimizations.ts',
  'compare-drama-cdn.ts',
]);
export function isRuntimeLogFile(path) {
  // New scripts are checked by default; human/JSON CLI exceptions require an explicit review.
  return !path.startsWith('scripts/') || !offlineScripts.has(path.slice('scripts/'.length));
}
const problems = [];
let checked = 0;
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(filename);
      continue;
    }
    if (
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.d.ts')
    )
      continue;
    const path = relative(root, filename).replaceAll('\\', '/');
    // Offline import/replay/report CLIs have an intentional human/JSON stdout contract.
    if (!isRuntimeLogFile(path)) continue;
    checked++;
    const source = readFileSync(filename, 'utf8');
    problems.push(...inspectLogging(source, path).map((problem) => `${path}: ${problem}`));
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  visit(root);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else
    console.log(
      `Backend logging guard passed (${checked} runtime files; offline CLI output excluded).`
    );
}
