/**
 * Receiver-independent, syntax-only rule: a `*.invalidateQueries(...)` call's
 * returned promise must be awaited, returned, the concise body of an arrow
 * function, or (awaited/returned) composed only through `.then`/`.catch`/
 * `.finally` chaining and/or `Promise.all`/`allSettled`/`race`/`any` array
 * elements. Anything else — a bare statement, an arbitrary call argument, an
 * assignment for later use, or `void` — is reported as discarded.
 *
 * Deliberate limits (syntax-only, no type/binding information):
 * - Identifier trust, not binding resolution: `invalidateQueries` is matched
 *   by static property name only; bound/property-aliased references
 *   (`const inv = receiver.invalidateQueries; inv()`) are not tracked.
 * - `auditedDetachFunctions` wrapper names are matched by identifier text at
 *   the call site, not by resolving the import/binding; a shadowed or
 *   re-imported identifier with the same name is trusted. The invalidateQueries
 *   call (optionally optional-chained) must be a *direct* argument of that
 *   wrapper call — reaching the wrapper through a `.then`/combinator chain
 *   does not qualify. The option provides no regex/glob matching; generic
 *   ESLint disables, call-site comment suppressions, and broad call-site
 *   ledgers are not approved substitutes. Wrapper aliases with different local
 *   names are not recognized unless that exact alias text is configured.
 * - Auditing a wrapper name does not prove that the wrapper consumes rejection
 *   or constrain its number of callers. Adopters/reviewers own those checks;
 *   FinPulse backstops them in `refreshContracts.test.ts`.
 * - Assignment-then-later-await dataflow (`const p = x.invalidateQueries();
 *   await p`) is not tracked; it is always reported.
 * - `ConditionalExpression`, `LogicalExpression`, and `SequenceExpression`
 *   composition is not transparent in the bounded ownership walk. Neither are
 *   TypeScript `TSAsExpression` or `TSNonNullExpression` wrappers. A nested
 *   invalidateQueries call can therefore be reported even when an outer
 *   `await` or `return` owns the composed result; the adopter's Task 3 census
 *   is the backstop for identifying these syntax shapes.
 * - No-substitution template-literal computed properties (for example,
 *   ``receiver[`invalidateQueries`]()``) are not recognized. Promise
 *   combinators are recognized only on an Identifier object, so forms such as
 *   `globalThis.Promise.all(...)` are also outside the ownership walk.
 * - Arbitrary callback consumers: a concise arrow body is always treated as
 *   owned even if the function it's passed to ignores the return value
 *   (e.g. `setTimeout(() => x.invalidateQueries(), 0)`); syntax alone cannot
 *   distinguish an honoring consumer from one that discards it.
 * - Coexists with `@typescript-eslint/no-floating-promises`: that type-aware
 *   rule flags any discarded promise-returning expression and accepts `void`
 *   as an escape hatch. This rule is a narrower, syntax-only companion
 *   specific to invalidateQueries lifecycle ownership, and `void` alone is
 *   never an accepted detach here — use a configured `auditedDetachFunctions`
 *   wrapper instead.
 * - Makes no claim about query-key completeness or whether `mutationKey`/
 *   `useMutationState` is required; sibling QueryClient methods are not
 *   inspected. Those concerns are outside syntax-only lint scope.
 */

const CHAIN_METHODS = new Set(['then', 'catch', 'finally'])
const PROMISE_COMBINATORS = new Set(['all', 'allSettled', 'race', 'any'])

function staticPropertyName(member) {
  if (member.computed) {
    return member.property.type === 'Literal' && typeof member.property.value === 'string'
      ? member.property.value
      : null
  }
  return member.property.type === 'Identifier' ? member.property.name : null
}

function isInvalidateQueriesCallee(callee) {
  const member = callee?.type === 'ChainExpression' ? callee.expression : callee
  return member?.type === 'MemberExpression' && staticPropertyName(member) === 'invalidateQueries'
}

function isPromiseCombinatorCallee(callee) {
  if (callee?.type !== 'MemberExpression') {return false}
  if (callee.object.type !== 'Identifier' || callee.object.name !== 'Promise') {return false}
  const name = staticPropertyName(callee)
  return name != null && PROMISE_COMBINATORS.has(name)
}

function stepChainExpression(node, parent) {
  return parent.type === 'ChainExpression' && parent.expression === node ? parent : null
}

function stepChainMember(node, parent) {
  if (parent.type !== 'MemberExpression' || parent.object !== node) {return null}
  const grand = parent.parent
  if (!grand || grand.type !== 'CallExpression' || grand.callee !== parent) {return null}
  const name = staticPropertyName(parent)
  return name != null && CHAIN_METHODS.has(name) ? grand : null
}

function stepCombinatorArray(node, parent) {
  if (parent.type !== 'ArrayExpression') {return null}
  const grand = parent.parent
  if (!grand || grand.type !== 'CallExpression') {return null}
  if (!isPromiseCombinatorCallee(grand.callee)) {return null}
  return grand.arguments[0] === parent ? grand : null
}

function isOwningParent(parent, node) {
  if (parent.type === 'AwaitExpression' && parent.argument === node) {return true}
  if (parent.type === 'ReturnStatement' && parent.argument === node) {return true}
  if (parent.type === 'ArrowFunctionExpression' && parent.body === node) {return true}
  return false
}

function ownershipVerdict(callNode) {
  let node = callNode
  let parent = node.parent
  while (parent) {
    const next = stepChainExpression(node, parent) || stepChainMember(node, parent) || stepCombinatorArray(node, parent)
    if (next) {
      node = next
      parent = node.parent
      continue
    }
    if (isOwningParent(parent, node)) {return { owned: true }}
    if (parent.type === 'UnaryExpression' && parent.operator === 'void' && parent.argument === node) {
      return { owned: false, isVoid: true }
    }
    return { owned: false }
  }
  return { owned: false }
}

function auditedDetachNames(context) {
  return context.options[0]?.auditedDetachFunctions ?? []
}

function isDirectAuditedArgument(context, callNode) {
  let node = callNode
  let parent = node.parent
  if (parent?.type === 'ChainExpression' && parent.expression === node) {
    node = parent
    parent = node.parent
  }
  if (parent?.type !== 'CallExpression' || !parent.arguments.includes(node)) {return false}
  return parent.callee.type === 'Identifier' && auditedDetachNames(context).includes(parent.callee.name)
}

function check(context, callNode) {
  if (isDirectAuditedArgument(context, callNode)) {return}
  const verdict = ownershipVerdict(callNode)
  if (verdict.owned) {return}
  context.report({
    node: callNode,
    messageId: verdict.isVoid ? 'voidDiscardedInvalidate' : 'discardedInvalidate',
  })
}

export const noDiscardedInvalidateQueries = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'forbid discarded *.invalidateQueries() promises unless awaited, returned, the concise body of an arrow function, or passed as a direct argument to a configured audited-detach wrapper',
    },
    schema: [{
      type: 'object',
      properties: { auditedDetachFunctions: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    }],
    messages: {
      discardedInvalidate:
        'invalidateQueries() promise must be awaited, returned, or passed as a direct argument to a wrapper configured in auditedDetachFunctions.',
      voidDiscardedInvalidate:
        '`void` does not audit a discarded invalidateQueries() call; configure an explicit auditedDetachFunctions wrapper instead.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isInvalidateQueriesCallee(node.callee)) {check(context, node)}
      },
    }
  },
}
