/**
 * @author Yosuke Ota
 * @copyright 2022 Yosuke Ota. All rights reserved.
 * See LICENSE file in root directory for full license.
 */
'use strict'

const utils = require('./index')
const eslintUtils = require('eslint-utils')
const { definePropertyReferenceExtractor } = require('./property-references')
const { ReferenceTracker } = eslintUtils

// ------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------

/**
 * @typedef {object} RefObjectReferenceForExpression
 * @property {'expression'} type
 * @property {MemberExpression | CallExpression} node
 * @property {string} method
 * @property {CallExpression} define
 *
 * @typedef {object} RefObjectReferenceForPattern
 * @property {'pattern'} type
 * @property {ObjectPattern} node
 * @property {string} method
 * @property {CallExpression} define
 *
 * @typedef {object} RefObjectReferenceForIdentifier
 * @property {'expression' | 'pattern'} type
 * @property {Identifier} node
 * @property {VariableDeclaration | null} variableDeclaration
 * @property {string} method
 * @property {CallExpression} define
 *
 * @typedef {RefObjectReferenceForIdentifier | RefObjectReferenceForExpression | RefObjectReferenceForPattern} RefObjectReference
 */
/**
 * @typedef {object} ReactiveVariableReference
 * @property {Identifier} node
 * @property {boolean} escape Within escape hint (`$$()`)
 * @property {VariableDeclaration} variableDeclaration
 * @property {string} method
 * @property {CallExpression} define
 */

/**
 * @typedef {object} RefObjectReferences
 * @property {<T extends Identifier | Expression | Pattern | Super> (node: T) =>
 *   T extends Identifier ?
 *     RefObjectReferenceForIdentifier | null :
 *   T extends Expression ?
 *     RefObjectReferenceForExpression | null :
 *   T extends Pattern ?
 *     RefObjectReferenceForPattern | null :
 *   null} get
 */
/**
 * @typedef {object} ReactiveVariableReferences
 * @property {(node: Identifier) => ReactiveVariableReference | null} get
 */

const REF_MACROS = [
  '$ref',
  '$computed',
  '$shallowRef',
  '$customRef',
  '$toRef',
  '$'
]

/** @type {WeakMap<Program, RefObjectReferences>} */
const cacheForRefObjectReferences = new WeakMap()
/** @type {WeakMap<Program, ReactiveVariableReferences>} */
const cacheForReactiveVariableReferences = new WeakMap()

/**
 * Iterate the call expressions that define the ref object.
 * @param {import('eslint').Scope.Scope} globalScope
 * @returns {Iterable<{ node: CallExpression, name: string }>}
 */
function* iterateDefineRefs(globalScope) {
  const tracker = new ReferenceTracker(globalScope)
  const traceMap = utils.createCompositionApiTraceMap({
    [ReferenceTracker.ESM]: true,
    ref: {
      [ReferenceTracker.CALL]: true
    },
    computed: {
      [ReferenceTracker.CALL]: true
    },
    toRef: {
      [ReferenceTracker.CALL]: true
    },
    customRef: {
      [ReferenceTracker.CALL]: true
    },
    shallowRef: {
      [ReferenceTracker.CALL]: true
    },
    toRefs: {
      [ReferenceTracker.CALL]: true
    }
  })
  for (const { node, path } of tracker.iterateEsmReferences(traceMap)) {
    const expr = /** @type {CallExpression} */ (node)
    yield {
      node: expr,
      name: path[path.length - 1]
    }
  }
}

/**
 * Iterate the call expressions that define the reactive variables.
 * @param {import('eslint').Scope.Scope} globalScope
 * @returns {Iterable<{ node: CallExpression, name: string }>}
 */
function* iterateDefineReactiveVariables(globalScope) {
  for (const { identifier } of iterateRefMacroReferences()) {
    if (
      identifier.parent.type === 'CallExpression' &&
      identifier.parent.callee === identifier
    ) {
      yield {
        node: identifier.parent,
        name: identifier.name
      }
    }
  }

  /**
   * Iterate ref macro reference.
   * @returns {Iterable<Reference>}
   */
  function* iterateRefMacroReferences() {
    yield* REF_MACROS.map((m) => globalScope.set.get(m))
      .filter(utils.isDef)
      .flatMap((v) => v.references)
    for (const ref of globalScope.through) {
      if (REF_MACROS.includes(ref.identifier.name)) {
        yield ref
      }
    }
  }
}

/**
 *  Iterate the call expressions that the escape hint values.
 * @param {import('eslint').Scope.Scope} globalScope
 * @returns {Iterable<CallExpression>}
 */
function* iterateEscapeHintValueRefs(globalScope) {
  for (const { identifier } of iterateEscapeHintReferences()) {
    if (
      identifier.parent.type === 'CallExpression' &&
      identifier.parent.callee === identifier
    ) {
      yield identifier.parent
    }
  }

  /**
   * Iterate escape hint reference.
   * @returns {Iterable<Reference>}
   */
  function* iterateEscapeHintReferences() {
    const escapeHint = globalScope.set.get('$$')
    if (escapeHint) {
      yield* escapeHint.references
    }
    for (const ref of globalScope.through) {
      if (ref.identifier.name === '$$') {
        yield ref
      }
    }
  }
}

/**
 * Extract identifier from given pattern node.
 * @param {Pattern} node
 * @returns {Iterable<Identifier>}
 */
function* extractIdentifier(node) {
  switch (node.type) {
    case 'Identifier': {
      yield node
      break
    }
    case 'ObjectPattern': {
      for (const property of node.properties) {
        if (property.type === 'Property') {
          yield* extractIdentifier(property.value)
        } else if (property.type === 'RestElement') {
          yield* extractIdentifier(property)
        }
      }
      break
    }
    case 'ArrayPattern': {
      for (const element of node.elements) {
        if (element) {
          yield* extractIdentifier(element)
        }
      }
      break
    }
    case 'AssignmentPattern': {
      yield* extractIdentifier(node.left)
      break
    }
    case 'RestElement': {
      yield* extractIdentifier(node.argument)
      break
    }
    case 'MemberExpression': {
      // can't extract
      break
    }
    // No default
  }
}

/**
 * Iterate references of the given identifier.
 * @param {Identifier} id
 * @param {import('eslint').Scope.Scope} globalScope
 * @returns {Iterable<import('eslint').Scope.Reference>}
 */
function* iterateIdentifierReferences(id, globalScope) {
  const variable = eslintUtils.findVariable(globalScope, id)
  if (!variable) {
    return
  }

  for (const reference of variable.references) {
    yield reference
  }
}

/**
 * @param {RuleContext} context The rule context.
 */
function getGlobalScope(context) {
  const sourceCode = context.getSourceCode()
  return (
    sourceCode.scopeManager.globalScope || sourceCode.scopeManager.scopes[0]
  )
}
// ------------------------------------------------------------------------------
// Public
// ------------------------------------------------------------------------------

module.exports = {
  extractRefObjectReferences,
  extractReactiveVariableReferences
}

/**
 * @implements {RefObjectReferences}
 */
class RefObjectReferenceExtractor {
  /**
   * @param {RuleContext} context The rule context.
   */
  constructor(context) {
    this.context = context
    /** @type {Map<Identifier | MemberExpression | CallExpression | ObjectPattern, RefObjectReference>} */
    this.references = new Map()

    /** @type {Set<Identifier>} */
    this._processedIds = new Set()
  }

  /**
   * @template {Identifier | Expression | Pattern | Super} T
   * @param {T} node
   * @returns {T extends Identifier ?
   *     RefObjectReferenceForIdentifier | null :
   *   T extends Expression ?
   *     RefObjectReferenceForExpression | null :
   *   T extends Pattern ?
   *     RefObjectReferenceForPattern | null :
   *   null}
   */
  get(node) {
    return /** @type {never} */ (
      this.references.get(/** @type {never} */ (node)) || null
    )
  }

  /**
   * @param {CallExpression} node
   * @param {string} method
   */
  processDefineRef(node, method) {
    const parent = node.parent
    /** @type {Pattern | null} */
    let pattern = null
    if (parent.type === 'VariableDeclarator') {
      pattern = parent.id
    } else if (
      parent.type === 'AssignmentExpression' &&
      parent.operator === '='
    ) {
      pattern = parent.left
    } else {
      if (method !== 'toRefs') {
        this.references.set(node, {
          type: 'expression',
          node,
          method,
          define: node
        })
      }
      return
    }

    if (method === 'toRefs') {
      const propertyReferenceExtractor = definePropertyReferenceExtractor(
        this.context
      )
      const propertyReferences =
        propertyReferenceExtractor.extractFromPattern(pattern)
      for (const name of propertyReferences.allProperties().keys()) {
        for (const nest of propertyReferences.getNestNodes(name)) {
          if (nest.type === 'expression') {
            this.processMemberExpression(nest.node, method, node)
          } else if (nest.type === 'pattern') {
            this.processPattern(nest.node, method, node)
          }
        }
      }
    } else {
      this.processPattern(pattern, method, node)
    }
  }

  /**
   * @param {Expression} node
   * @param {string} method
   * @param {CallExpression} define
   */
  processExpression(node, method, define) {
    const parent = node.parent
    if (parent.type === 'AssignmentExpression') {
      if (parent.operator === '=' && parent.right === node) {
        // `(foo = obj.mem)`
        this.processPattern(parent.left, method, define)
        return true
      }
    } else if (parent.type === 'VariableDeclarator' && parent.init === node) {
      // `const foo = obj.mem`
      this.processPattern(parent.id, method, define)
      return true
    }
    return false
  }
  /**
   * @param {MemberExpression} node
   * @param {string} method
   * @param {CallExpression} define
   */
  processMemberExpression(node, method, define) {
    if (this.processExpression(node, method, define)) {
      return
    }
    this.references.set(node, {
      type: 'expression',
      node,
      method,
      define
    })
  }

  /**
   * @param {Pattern} node
   * @param {string} method
   * @param {CallExpression} define
   */
  processPattern(node, method, define) {
    switch (node.type) {
      case 'Identifier': {
        this.processIdentifierPattern(node, method, define)
        break
      }
      case 'ArrayPattern':
      case 'RestElement':
      case 'MemberExpression': {
        return
      }
      case 'ObjectPattern': {
        this.references.set(node, {
          type: 'pattern',
          node,
          method,
          define
        })
        return
      }
      case 'AssignmentPattern': {
        this.processPattern(node.left, method, define)
        return
      }
      // No default
    }
  }

  /**
   * @param {Identifier} node
   * @param {string} method
   * @param {CallExpression} define
   */
  processIdentifierPattern(node, method, define) {
    if (this._processedIds.has(node)) {
      return
    }
    this._processedIds.add(node)

    for (const reference of iterateIdentifierReferences(
      node,
      getGlobalScope(this.context)
    )) {
      const def =
        reference.resolved &&
        reference.resolved.defs.length === 1 &&
        reference.resolved.defs[0].type === 'Variable'
          ? reference.resolved.defs[0]
          : null
      if (def && def.name === reference.identifier) {
        continue
      }
      if (
        reference.isRead() &&
        this.processExpression(reference.identifier, method, define)
      ) {
        continue
      }
      this.references.set(reference.identifier, {
        type: reference.isWrite() ? 'pattern' : 'expression',
        node: reference.identifier,
        method,
        define,
        variableDeclaration: def ? def.parent : null
      })
    }
  }
}

/**
 * Extracts references of all ref objects.
 * @param {RuleContext} context The rule context.
 * @returns {RefObjectReferences}
 */
function extractRefObjectReferences(context) {
  const sourceCode = context.getSourceCode()
  const cachedReferences = cacheForRefObjectReferences.get(sourceCode.ast)
  if (cachedReferences) {
    return cachedReferences
  }
  const references = new RefObjectReferenceExtractor(context)

  for (const { node, name } of iterateDefineRefs(getGlobalScope(context))) {
    references.processDefineRef(node, name)
  }

  cacheForRefObjectReferences.set(sourceCode.ast, references)

  return references
}

/**
 * @implements {ReactiveVariableReferences}
 */
class ReactiveVariableReferenceExtractor {
  /**
   * @param {RuleContext} context The rule context.
   */
  constructor(context) {
    this.context = context
    /** @type {Map<Identifier, ReactiveVariableReference>} */
    this.references = new Map()

    /** @type {Set<Identifier>} */
    this._processedIds = new Set()

    /** @type {Set<CallExpression>} */
    this._escapeHintValueRefs = new Set(
      iterateEscapeHintValueRefs(getGlobalScope(context))
    )
  }

  /**
   * @param {Identifier} node
   * @returns {ReactiveVariableReference | null}
   */
  get(node) {
    return this.references.get(node) || null
  }

  /**
   * @param {CallExpression} node
   * @param {string} method
   */
  processDefineReactiveVariable(node, method) {
    const parent = node.parent
    if (parent.type !== 'VariableDeclarator') {
      return
    }
    /** @type {Pattern | null} */
    const pattern = parent.id

    if (method === '$') {
      for (const id of extractIdentifier(pattern)) {
        this.processIdentifierPattern(id, method, node)
      }
    } else {
      if (pattern.type === 'Identifier') {
        this.processIdentifierPattern(pattern, method, node)
      }
    }
  }

  /**
   * @param {Identifier} node
   * @param {string} method
   * @param {CallExpression} define
   */
  processIdentifierPattern(node, method, define) {
    if (this._processedIds.has(node)) {
      return
    }
    this._processedIds.add(node)

    for (const reference of iterateIdentifierReferences(
      node,
      getGlobalScope(this.context)
    )) {
      const def =
        reference.resolved &&
        reference.resolved.defs.length === 1 &&
        reference.resolved.defs[0].type === 'Variable'
          ? reference.resolved.defs[0]
          : null
      if (!def || def.name === reference.identifier) {
        continue
      }
      this.references.set(reference.identifier, {
        node: reference.identifier,
        escape: this.withinEscapeHint(reference.identifier),
        method,
        define,
        variableDeclaration: def.parent
      })
    }
  }

  /**
   * Checks whether the given identifier node within the escape hints (`$$()`) or not.
   * @param {Identifier} node
   */
  withinEscapeHint(node) {
    /** @type {Identifier | ObjectExpression | ArrayExpression | SpreadElement | Property | AssignmentProperty} */
    let target = node
    /** @type {ASTNode | null} */
    let parent = target.parent
    while (parent) {
      if (parent.type === 'CallExpression') {
        if (
          parent.arguments.includes(/** @type {any} */ (target)) &&
          this._escapeHintValueRefs.has(parent)
        ) {
          return true
        }
        return false
      }
      if (
        (parent.type === 'Property' && parent.value === target) ||
        (parent.type === 'ObjectExpression' &&
          parent.properties.includes(/** @type {any} */ (target))) ||
        parent.type === 'ArrayExpression' ||
        parent.type === 'SpreadElement'
      ) {
        target = parent
        parent = target.parent
      } else {
        return false
      }
    }
    return false
  }
}

/**
 * Extracts references of all reactive variables.
 * @param {RuleContext} context The rule context.
 * @returns {ReactiveVariableReferences}
 */
function extractReactiveVariableReferences(context) {
  const sourceCode = context.getSourceCode()
  const cachedReferences = cacheForReactiveVariableReferences.get(
    sourceCode.ast
  )
  if (cachedReferences) {
    return cachedReferences
  }

  const references = new ReactiveVariableReferenceExtractor(context)

  for (const { node, name } of iterateDefineReactiveVariables(
    getGlobalScope(context)
  )) {
    references.processDefineReactiveVariable(node, name)
  }

  cacheForReactiveVariableReferences.set(sourceCode.ast, references)

  return references
}
