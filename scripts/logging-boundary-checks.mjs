// Complements fetch checks with explicit client creation and scheduler boundaries.
export function inspectBoundaries(ts, file, path) {
  // These helpers are reachable only from offline import/translation CLIs, not deployed workers.
  if (
    [
      'features/image-plaza/seed-import.ts',
      'features/image-plaza/seed-prompt-translate.ts',
    ].includes(path)
  )
    return [];
  const imports = new Map();
  const definitions = new Map();
  const problems = [];
  function walk(node, visit) {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  }
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
    const module = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (clause?.name) imports.set(clause.name.text, { module, name: 'default' });
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings))
      imports.set(bindings.name.text, { module, name: '*' });
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements)
        if (!item.isTypeOnly)
          imports.set(item.name.text, { module, name: (item.propertyName ?? item.name).text });
  }
  walk(file, (node) => {
    const name =
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        ? node.name.text
        : ts.isFunctionDeclaration(node)
          ? node.name?.text
          : undefined;
    if (name) definitions.set(name, definitions.has(name) ? undefined : (node.initializer ?? node));
  });
  function unwrap(node, seen = new Set()) {
    if (!node) return undefined;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return unwrap(node.expression, seen);
    if (ts.isIdentifier(node) && definitions.has(node.text) && !seen.has(node.text))
      return unwrap(definitions.get(node.text), new Set([...seen, node.text]));
    return node;
  }
  function imported(node) {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isIdentifier(node)) return imports.get(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      const owner = imported(node.expression);
      if (owner && ['*', 'default'].includes(owner.name))
        return { module: owner.module, name: node.name.text };
    }
    return undefined;
  }
  const isImport = (node, suffix, name) => {
    const info = imported(node);
    return info?.module.endsWith(suffix) && info.name === name;
  };
  function within(node, predicate) {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (ts.isCallExpression(parent) && predicate(parent.expression)) return true;
    return false;
  }
  function observationCall(node) {
    return (
      ts.isPropertyAccessExpression(node) &&
      ['observe', 'observeSync'].includes(node.name.text) &&
      isImport(node.expression, '/observability/runtime.js', 'observation')
    );
  }
  function valueReferences(name) {
    const refs = [];
    function visit(node) {
      if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
      if (
        ts.isIdentifier(node) &&
        node.text === name &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      )
        refs.push(node);
      ts.forEachChild(node, visit);
    }
    visit(file);
    return refs;
  }
  function observedPrisma(node) {
    const wrapped = (expression) =>
      isImport(expression, '/observability/prisma.js', 'applyPrismaObservation');
    if (within(node, wrapped)) return true;
    const declaration = node.parent;
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
    const refs = valueReferences(declaration.name.text);
    return refs.length > 0 && refs.every((ref) => within(ref, wrapped));
  }
  function property(node, name) {
    node = unwrap(node);
    if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
    const field = node.properties.find(
      (item) => item.name?.getText(file).replaceAll(/["']/g, '') === name
    );
    return (
      field &&
      (ts.isPropertyAssignment(field)
        ? field.initializer
        : ts.isShorthandPropertyAssignment(field)
          ? field.name
          : undefined)
    );
  }
  function observedFetch(node, depth = 0) {
    if (depth > 12) return false;
    node = unwrap(node);
    if (!node) return false;
    if (isImport(node, '/preparation-diagnostics.js', 'observedSupabaseFetch')) return true;
    if (ts.isCallExpression(node))
      return (
        isImport(node.expression, '/observability/fetch.js', 'clientFetch') ||
        isImport(node.expression, '/observability/fetch.js', 'observedFetch') ||
        observedFetch(node.expression, depth + 1)
      );
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      if (!node.body) return false;
      if (!ts.isBlock(node.body)) return observedFetch(node.body, depth + 1);
      const returns = [];
      const find = (child) => {
        if (ts.isFunctionLike(child)) return;
        if (ts.isReturnStatement(child)) returns.push(child.expression);
        ts.forEachChild(child, find);
      };
      find(node.body);
      return returns.length > 0 && returns.every((value) => observedFetch(value, depth + 1));
    }
    if (ts.isAwaitExpression(node)) return observedFetch(node.expression, depth + 1);
    return false;
  }
  function containsJob(node, depth = 0) {
    if (!node || depth > 12) return false;
    node = unwrap(node);
    if (!node) return false;
    if (ts.isFunctionLike(node)) node = node.body;
    let found = false;
    const find = (child) => {
      if (ts.isFunctionLike(child)) return; // A dormant closure is not scheduled work.
      if (ts.isCallExpression(child)) {
        if (
          isImport(child.expression, '/observability/jobs.js', 'runObservedJob') ||
          (ts.isIdentifier(child.expression) &&
            containsJob(definitions.get(child.expression.text), depth + 1))
        )
          found = true;
      }
      if (!found) ts.forEachChild(child, find);
    };
    if (node) find(node);
    return found;
  }
  function hasSleep(node) {
    let found = false;
    walk(node, (child) => {
      if (!ts.isAwaitExpression(child) || !ts.isCallExpression(child.expression)) return;
      const callee = child.expression.expression;
      const info = imported(callee);
      if (
        (info?.module.endsWith('timers/promises') && info.name === 'setTimeout') ||
        /(?:^|\.)(?:sleep|delay|wait)$/.test(callee.getText(file))
      )
        found = true;
    });
    return found;
  }
  function scheduledWork(node, depth = 0) {
    if (!node || depth > 12) return false;
    node = unwrap(node);
    if (!node) return false;
    if (ts.isFunctionLike(node)) return scheduledWork(node.body, depth + 1);
    if (ts.isBlock(node))
      return (
        node.statements.length > 0 &&
        node.statements.every((statement) => scheduledWork(statement, depth + 1))
      );
    if (
      ts.isExpressionStatement(node) ||
      ts.isReturnStatement(node) ||
      ts.isAwaitExpression(node) ||
      ts.isVoidExpression(node)
    )
      return scheduledWork(node.expression, depth + 1);
    if (ts.isCallExpression(node))
      return (
        isImport(node.expression, '/observability/jobs.js', 'runObservedJob') ||
        (ts.isIdentifier(node.expression) &&
          scheduledWork(definitions.get(node.expression.text), depth + 1))
      );
    return false;
  }
  const leaseOperations = new Set();
  walk(file, (node) => {
    if (ts.isNewExpression(node)) {
      const info = imported(node.expression);
      if (
        info?.module === '@prisma/client' &&
        info.name === 'PrismaClient' &&
        !observedPrisma(node)
      )
        problems.push('PrismaClient must be wrapped with applyPrismaObservation before use');
      if (
        info?.module === 'pg' &&
        ['Client', 'Pool'].includes(info.name) &&
        path !== 'lib/postgres-advisory-lease.ts'
      )
        problems.push('register PostgreSQL clients through the observed advisory lease boundary');
    }
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(file) === 'Error' &&
      node.arguments?.length &&
      !property(node.arguments[1], 'cause')
    ) {
      let copiedMessage = false;
      walk(node.arguments[0], (child) => {
        if (
          ts.isPropertyAccessExpression(child) &&
          child.name.text === 'message' &&
          /(?:^error$|^err$|Error$)/.test(child.expression.getText(file))
        )
          copiedMessage = true;
      });
      if (copiedMessage)
        problems.push('preserve the original database/error cause when wrapping its message');
    }
    if (ts.isCallExpression(node)) {
      const info = imported(node.expression);
      if (
        info?.module === '@supabase/supabase-js' &&
        info.name === 'createClient' &&
        !observedFetch(property(property(node.arguments[2], 'global'), 'fetch'))
      )
        problems.push('Supabase createClient requires an explicitly observed global.fetch');
      if (
        info &&
        ((info.module === 'undici' &&
          ['request', 'stream', 'pipeline', 'connect'].includes(info.name)) ||
          (/^(?:node:)?https?$/.test(info.module) && ['request', 'get'].includes(info.name))) &&
        !within(
          node,
          (callee) =>
            observationCall(callee) || isImport(callee, '/observability/fetch.js', 'observedFetch')
        )
      )
        problems.push('HTTP request/get clients require an observation around the actual call');
      const interval =
        node.expression.getText(file) === 'setInterval' ||
        (info?.module.replace(/^node:/, '') === 'timers' && info.name === 'setInterval');
      if (interval && path !== 'lib/perf-metrics.ts' && !scheduledWork(node.arguments[0]))
        problems.push('scheduled callback requires runObservedJob on its execution path');
      if (
        observationCall(node.expression) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        leaseOperations.add(node.arguments[0].text);
    }
    if (
      (ts.isWhileStatement(node) ||
        ts.isDoStatement(node) ||
        (ts.isForStatement(node) && !node.condition)) &&
      hasSleep(node.statement) &&
      !containsJob(node.statement)
    )
      problems.push('polling loop requires a runObservedJob boundary for each round');
  });
  if (
    path === 'lib/postgres-advisory-lease.ts' &&
    !['connect', 'lock', 'unlock', 'close'].every((stage) =>
      leaseOperations.has(`db.lease.${stage}`)
    )
  )
    problems.push('the PostgreSQL lease owner must observe connect/lock/unlock/close');
  return [...new Set(problems)];
}
