import * as t from '@babel/types'
import babel from '@babel/core'
import * as template from '@babel/template'
import {
  deadCodeElimination,
  findReferencedIdentifiers,
} from 'babel-dead-code-elimination'
import { generateFromAst, parseAst } from '@tanstack/router-utils'
import { tsrSplit } from '../constants'
import { routeHmrStatement } from '../route-hmr-statement'
import { createIdentifier } from './path-ids'
import { getFrameworkOptions } from './framework-options'
import type { GeneratorResult, ParseAstOptions } from '@tanstack/router-utils'
import type { CodeSplitGroupings, SplitRouteIdentNodes } from '../constants'
import type { Config, DeletableNodes } from '../config'

type SplitNodeMeta = {
  routeIdent: SplitRouteIdentNodes
  splitStrategy: 'lazyFn' | 'lazyRouteComponent'
  localImporterIdent: string
  exporterIdent: string
  localExporterIdent: string
}
const SPLIT_NODES_CONFIG = new Map<SplitRouteIdentNodes, SplitNodeMeta>([
  [
    'loader',
    {
      routeIdent: 'loader',
      localImporterIdent: '$$splitLoaderImporter', // const $$splitLoaderImporter = () => import('...')
      splitStrategy: 'lazyFn',
      localExporterIdent: 'SplitLoader', // const SplitLoader = ...
      exporterIdent: 'loader', // export { SplitLoader as loader }
    },
  ],
  [
    'component',
    {
      routeIdent: 'component',
      localImporterIdent: '$$splitComponentImporter', // const $$splitComponentImporter = () => import('...')
      splitStrategy: 'lazyRouteComponent',
      localExporterIdent: 'SplitComponent', // const SplitComponent = ...
      exporterIdent: 'component', // export { SplitComponent as component }
    },
  ],
  [
    'pendingComponent',
    {
      routeIdent: 'pendingComponent',
      localImporterIdent: '$$splitPendingComponentImporter', // const $$splitPendingComponentImporter = () => import('...')
      splitStrategy: 'lazyRouteComponent',
      localExporterIdent: 'SplitPendingComponent', // const SplitPendingComponent = ...
      exporterIdent: 'pendingComponent', // export { SplitPendingComponent as pendingComponent }
    },
  ],
  [
    'errorComponent',
    {
      routeIdent: 'errorComponent',
      localImporterIdent: '$$splitErrorComponentImporter', // const $$splitErrorComponentImporter = () => import('...')
      splitStrategy: 'lazyRouteComponent',
      localExporterIdent: 'SplitErrorComponent', // const SplitErrorComponent = ...
      exporterIdent: 'errorComponent', // export { SplitErrorComponent as errorComponent }
    },
  ],
  [
    'notFoundComponent',
    {
      routeIdent: 'notFoundComponent',
      localImporterIdent: '$$splitNotFoundComponentImporter', // const $$splitNotFoundComponentImporter = () => import('...')
      splitStrategy: 'lazyRouteComponent',
      localExporterIdent: 'SplitNotFoundComponent', // const SplitNotFoundComponent = ...
      exporterIdent: 'notFoundComponent', // export { SplitNotFoundComponent as notFoundComponent }
    },
  ],
])
const KNOWN_SPLIT_ROUTE_IDENTS = [...SPLIT_NODES_CONFIG.keys()] as const

function addSplitSearchParamToFilename(
  filename: string,
  grouping: Array<string>,
) {
  const [bareFilename] = filename.split('?')

  const params = new URLSearchParams()
  params.append(tsrSplit, createIdentifier(grouping))

  return `${bareFilename}?${params.toString()}`
}

function removeSplitSearchParamFromFilename(filename: string) {
  const [bareFilename] = filename.split('?')
  return bareFilename!
}

const splittableCreateRouteFns = ['createFileRoute']
const unsplittableCreateRouteFns = [
  'createRootRoute',
  'createRootRouteWithContext',
]
const allCreateRouteFns = [
  ...splittableCreateRouteFns,
  ...unsplittableCreateRouteFns,
]

export function compileCodeSplitReferenceRoute(
  opts: ParseAstOptions & {
    codeSplitGroupings: CodeSplitGroupings
    deleteNodes?: Set<DeletableNodes>
    targetFramework: Config['target']
    filename: string
    id: string
    addHmr?: boolean
  },
): GeneratorResult {
  const ast = parseAst(opts)

  const refIdents = findReferencedIdentifiers(ast)

  function findIndexForSplitNode(str: string) {
    return opts.codeSplitGroupings.findIndex((group) =>
      group.includes(str as any),
    )
  }

  const frameworkOptions = getFrameworkOptions(opts.targetFramework)
  const PACKAGE = frameworkOptions.package
  const LAZY_ROUTE_COMPONENT_IDENT = frameworkOptions.idents.lazyRouteComponent
  const LAZY_FN_IDENT = frameworkOptions.idents.lazyFn

  let createRouteFn: string

  babel.traverse(ast, {
    Program: {
      enter(programPath) {
        /**
         * If the component for the route is being imported from
         * another file, this is to track the path to that file
         * the path itself doesn't matter, we just need to keep
         * track of it so that we can remove it from the imports
         * list if it's not being used like:
         *
         * `import '../shared/imported'`
         */
        const removableImportPaths = new Set<string>([])

        programPath.traverse({
          CallExpression: (path) => {
            if (!t.isIdentifier(path.node.callee)) {
              return
            }

            if (!allCreateRouteFns.includes(path.node.callee.name)) {
              return
            }

            createRouteFn = path.node.callee.name

            function babelHandleReference(routeOptions: t.Node | undefined) {
              const hasImportedOrDefinedIdentifier = (name: string) => {
                return programPath.scope.hasBinding(name)
              }

              if (t.isObjectExpression(routeOptions)) {
                if (opts.deleteNodes && opts.deleteNodes.size > 0) {
                  routeOptions.properties = routeOptions.properties.filter(
                    (prop) => {
                      if (t.isObjectProperty(prop)) {
                        if (t.isIdentifier(prop.key)) {
                          if (opts.deleteNodes?.has(prop.key.name as any)) {
                            return false
                          }
                        }
                      }
                      return true
                    },
                  )
                }
                if (!splittableCreateRouteFns.includes(createRouteFn)) {
                  // we can't split this route but we still add HMR handling if enabled
                  if (opts.addHmr) {
                    programPath.pushContainer('body', routeHmrStatement)
                  }
                  // exit traversal so this route is not split
                  return programPath.stop()
                }
                routeOptions.properties.forEach((prop) => {
                  if (t.isObjectProperty(prop)) {
                    if (t.isIdentifier(prop.key)) {
                      const key = prop.key.name

                      // If the user has not specified a split grouping for this key
                      // then we should not split it
                      const codeSplitGroupingByKey = findIndexForSplitNode(key)
                      if (codeSplitGroupingByKey === -1) {
                        return
                      }
                      const codeSplitGroup = [
                        ...new Set(
                          opts.codeSplitGroupings[codeSplitGroupingByKey],
                        ),
                      ]

                      // find key in nodeSplitConfig
                      const isNodeConfigAvailable = SPLIT_NODES_CONFIG.has(
                        key as any,
                      )

                      if (!isNodeConfigAvailable) {
                        return
                      }

                      // Exit early if the value is undefined
                      // Since we don't need to run an import just to get the value of `undefined`
                      // This is useful for cases like: `createFileRoute('/')({ component: undefined })`
                      if (
                        t.isIdentifier(prop.value) &&
                        prop.value.name === 'undefined'
                      ) {
                        return
                      }

                      const splitNodeMeta = SPLIT_NODES_CONFIG.get(key as any)!

                      // We need to extract the existing search params from the filename, if any
                      // and add the relevant codesplitPrefix to them, then write them back to the filename
                      const splitUrl = addSplitSearchParamToFilename(
                        opts.filename,
                        codeSplitGroup,
                      )

                      if (
                        splitNodeMeta.splitStrategy === 'lazyRouteComponent'
                      ) {
                        const value = prop.value

                        let shouldSplit = true

                        if (t.isIdentifier(value)) {
                          const existingImportPath =
                            getImportSpecifierAndPathFromLocalName(
                              programPath,
                              value.name,
                            ).path
                          if (existingImportPath) {
                            removableImportPaths.add(existingImportPath)
                          }

                          // exported identifiers should not be split
                          // since they are already being imported
                          // and need to be retained in the compiled file
                          const isExported = hasExport(ast, value)
                          shouldSplit = !isExported

                          if (shouldSplit) {
                            removeIdentifierLiteral(path, value)
                          }
                        }

                        if (!shouldSplit) {
                          return
                        }

                        // Prepend the import statement to the program along with the importer function
                        // Check to see if lazyRouteComponent is already imported before attempting
                        // to import it again
                        if (
                          !hasImportedOrDefinedIdentifier(
                            LAZY_ROUTE_COMPONENT_IDENT,
                          )
                        ) {
                          programPath.unshiftContainer('body', [
                            template.statement(
                              `import { ${LAZY_ROUTE_COMPONENT_IDENT} } from '${PACKAGE}'`,
                            )(),
                          ])
                        }

                        // Check to see if the importer function is already defined
                        // If not, define it with the dynamic import statement
                        if (
                          !hasImportedOrDefinedIdentifier(
                            splitNodeMeta.localImporterIdent,
                          )
                        ) {
                          programPath.unshiftContainer('body', [
                            template.statement(
                              `const ${splitNodeMeta.localImporterIdent} = () => import('${splitUrl}')`,
                            )(),
                          ])
                        }

                        prop.value = template.expression(
                          `${LAZY_ROUTE_COMPONENT_IDENT}(${splitNodeMeta.localImporterIdent}, '${splitNodeMeta.exporterIdent}')`,
                        )()

                        // add HMR handling
                        if (opts.addHmr) {
                          programPath.pushContainer('body', routeHmrStatement)
                        }
                      }

                      if (splitNodeMeta.splitStrategy === 'lazyFn') {
                        const value = prop.value

                        let shouldSplit = true

                        if (t.isIdentifier(value)) {
                          const existingImportPath =
                            getImportSpecifierAndPathFromLocalName(
                              programPath,
                              value.name,
                            ).path
                          if (existingImportPath) {
                            removableImportPaths.add(existingImportPath)
                          }

                          // exported identifiers should not be split
                          // since they are already being imported
                          // and need to be retained in the compiled file
                          const isExported = hasExport(ast, value)
                          shouldSplit = !isExported

                          if (shouldSplit) {
                            removeIdentifierLiteral(path, value)
                          }
                        }

                        if (!shouldSplit) {
                          return
                        }

                        // Prepend the import statement to the program along with the importer function
                        if (!hasImportedOrDefinedIdentifier(LAZY_FN_IDENT)) {
                          programPath.unshiftContainer(
                            'body',
                            template.smart(
                              `import { ${LAZY_FN_IDENT} } from '${PACKAGE}'`,
                            )(),
                          )
                        }

                        // Check to see if the importer function is already defined
                        // If not, define it with the dynamic import statement
                        if (
                          !hasImportedOrDefinedIdentifier(
                            splitNodeMeta.localImporterIdent,
                          )
                        ) {
                          programPath.unshiftContainer('body', [
                            template.statement(
                              `const ${splitNodeMeta.localImporterIdent} = () => import('${splitUrl}')`,
                            )(),
                          ])
                        }

                        // Add the lazyFn call with the dynamic import to the prop value
                        prop.value = template.expression(
                          `${LAZY_FN_IDENT}(${splitNodeMeta.localImporterIdent}, '${splitNodeMeta.exporterIdent}')`,
                        )()
                      }
                    }
                  }

                  programPath.scope.crawl()
                })
              }
            }

            if (t.isCallExpression(path.parentPath.node)) {
              // createFileRoute('/')({ ... })
              const options = resolveIdentifier(
                path,
                path.parentPath.node.arguments[0],
              )

              babelHandleReference(options)
            } else if (t.isVariableDeclarator(path.parentPath.node)) {
              // createFileRoute({ ... })
              const caller = resolveIdentifier(path, path.parentPath.node.init)

              if (t.isCallExpression(caller)) {
                const options = resolveIdentifier(path, caller.arguments[0])
                babelHandleReference(options)
              }
            }
          },
        })

        /**
         * If the component for the route is being imported,
         * and it's not being used, remove the import statement
         * from the program, by checking that the import has no
         * specifiers
         */
        if (removableImportPaths.size > 0) {
          programPath.traverse({
            ImportDeclaration(path) {
              if (path.node.specifiers.length > 0) return
              if (removableImportPaths.has(path.node.source.value)) {
                path.remove()
              }
            },
          })
        }
      },
    },
  })

  deadCodeElimination(ast, refIdents)

  return generateFromAst(ast, {
    sourceMaps: true,
    sourceFileName: opts.filename,
    filename: opts.filename,
  })
}

export function compileCodeSplitVirtualRoute(
  opts: ParseAstOptions & {
    splitTargets: Array<SplitRouteIdentNodes>
    filename: string
  },
): GeneratorResult {
  const ast = parseAst(opts)
  const refIdents = findReferencedIdentifiers(ast)

  const intendedSplitNodes = new Set(opts.splitTargets)

  const knownExportedIdents = new Set<string>()

  babel.traverse(ast, {
    Program: {
      enter(programPath) {
        const trackedNodesToSplitByType: Record<
          SplitRouteIdentNodes,
          { node: t.Node | undefined; meta: SplitNodeMeta } | undefined
        > = {
          component: undefined,
          loader: undefined,
          pendingComponent: undefined,
          errorComponent: undefined,
          notFoundComponent: undefined,
        }

        // Find and track all the known split-able nodes
        programPath.traverse({
          CallExpression: (path) => {
            if (!t.isIdentifier(path.node.callee)) {
              return
            }

            if (!splittableCreateRouteFns.includes(path.node.callee.name)) {
              return
            }

            function babelHandleVirtual(options: t.Node | undefined) {
              if (t.isObjectExpression(options)) {
                options.properties.forEach((prop) => {
                  if (t.isObjectProperty(prop)) {
                    // do not use `intendedSplitNodes` here
                    // since we have special considerations that need
                    // to be accounted for like (not splitting exported identifiers)
                    KNOWN_SPLIT_ROUTE_IDENTS.forEach((splitType) => {
                      if (
                        !t.isIdentifier(prop.key) ||
                        prop.key.name !== splitType
                      ) {
                        return
                      }

                      const value = prop.value

                      // If the value for the `key` is `undefined`, then we don't need to include it
                      // in the split file, so we can just return, since it will kept in-place in the
                      // reference file
                      // This is useful for cases like: `createFileRoute('/')({ component: undefined })`
                      if (t.isIdentifier(value) && value.name === 'undefined') {
                        return
                      }

                      let isExported = false
                      if (t.isIdentifier(value)) {
                        isExported = hasExport(ast, value)
                        if (isExported) {
                          knownExportedIdents.add(value.name)
                        }
                      }

                      // If the node is exported, we need to remove
                      // the export from the split file
                      if (isExported && t.isIdentifier(value)) {
                        removeExports(ast, value)
                      } else {
                        const meta = SPLIT_NODES_CONFIG.get(splitType)!
                        trackedNodesToSplitByType[splitType] = {
                          node: prop.value,
                          meta,
                        }
                      }
                    })
                  }
                })

                // Remove all of the options
                options.properties = []
              }
            }

            if (t.isCallExpression(path.parentPath.node)) {
              // createFileRoute('/')({ ... })
              const options = resolveIdentifier(
                path,
                path.parentPath.node.arguments[0],
              )

              babelHandleVirtual(options)
            } else if (t.isVariableDeclarator(path.parentPath.node)) {
              // createFileRoute({ ... })
              const caller = resolveIdentifier(path, path.parentPath.node.init)

              if (t.isCallExpression(caller)) {
                const options = resolveIdentifier(path, caller.arguments[0])
                babelHandleVirtual(options)
              }
            }
          },
        })

        // Start the transformation to only exported the intended split nodes
        intendedSplitNodes.forEach((SPLIT_TYPE) => {
          const splitKey = trackedNodesToSplitByType[SPLIT_TYPE]

          if (!splitKey) {
            return
          }

          let splitNode = splitKey.node
          const splitMeta = splitKey.meta

          while (t.isIdentifier(splitNode)) {
            const binding = programPath.scope.getBinding(splitNode.name)
            splitNode = binding?.path.node
          }

          // Add the node to the program
          if (splitNode) {
            if (t.isFunctionDeclaration(splitNode)) {
              programPath.pushContainer(
                'body',
                t.variableDeclaration('const', [
                  t.variableDeclarator(
                    t.identifier(splitMeta.localExporterIdent),
                    t.functionExpression(
                      splitNode.id || null, // Anonymize the function expression
                      splitNode.params,
                      splitNode.body,
                      splitNode.generator,
                      splitNode.async,
                    ),
                  ),
                ]),
              )
            } else if (
              t.isFunctionExpression(splitNode) ||
              t.isArrowFunctionExpression(splitNode)
            ) {
              programPath.pushContainer(
                'body',
                t.variableDeclaration('const', [
                  t.variableDeclarator(
                    t.identifier(splitMeta.localExporterIdent),
                    splitNode as any,
                  ),
                ]),
              )
            } else if (
              t.isImportSpecifier(splitNode) ||
              t.isImportDefaultSpecifier(splitNode)
            ) {
              programPath.pushContainer(
                'body',
                t.variableDeclaration('const', [
                  t.variableDeclarator(
                    t.identifier(splitMeta.localExporterIdent),
                    splitNode.local,
                  ),
                ]),
              )
            } else if (t.isVariableDeclarator(splitNode)) {
              programPath.pushContainer(
                'body',
                t.variableDeclaration('const', [
                  t.variableDeclarator(
                    t.identifier(splitMeta.localExporterIdent),
                    splitNode.init,
                  ),
                ]),
              )
            } else if (t.isCallExpression(splitNode)) {
              const outputSplitNodeCode = generateFromAst(splitNode).code
              const splitNodeAst = babel.parse(outputSplitNodeCode)

              if (!splitNodeAst) {
                throw new Error(
                  `Failed to parse the generated code for "${SPLIT_TYPE}" in the node type "${splitNode.type}"`,
                )
              }

              const statement = splitNodeAst.program.body[0]

              if (!statement) {
                throw new Error(
                  `Failed to parse the generated code for "${SPLIT_TYPE}" in the node type "${splitNode.type}" as no statement was found in the program body`,
                )
              }

              if (t.isExpressionStatement(statement)) {
                const expression = statement.expression
                programPath.pushContainer(
                  'body',
                  t.variableDeclaration('const', [
                    t.variableDeclarator(
                      t.identifier(splitMeta.localExporterIdent),
                      expression,
                    ),
                  ]),
                )
              } else {
                throw new Error(
                  `Unexpected expression type encounter for "${SPLIT_TYPE}" in the node type "${splitNode.type}"`,
                )
              }
            } else if (t.isConditionalExpression(splitNode)) {
              programPath.pushContainer(
                'body',
                t.variableDeclaration('const', [
                  t.variableDeclarator(
                    t.identifier(splitMeta.localExporterIdent),
                    splitNode,
                  ),
                ]),
              )
            } else if (t.isTSAsExpression(splitNode)) {
              // remove the type assertion
              splitNode = splitNode.expression
              programPath.pushContainer(
                'body',
                t.variableDeclaration('const', [
                  t.variableDeclarator(
                    t.identifier(splitMeta.localExporterIdent),
                    splitNode,
                  ),
                ]),
              )
            } else {
              console.info('Unexpected splitNode type:', splitNode)
              throw new Error(`Unexpected splitNode type ☝️: ${splitNode.type}`)
            }
          }

          // If the splitNode exists at the top of the program
          // then we need to remove that copy
          programPath.node.body = programPath.node.body.filter((node) => {
            return node !== splitNode
          })

          // Export the node
          programPath.pushContainer('body', [
            t.exportNamedDeclaration(null, [
              t.exportSpecifier(
                t.identifier(splitMeta.localExporterIdent), // local variable name
                t.identifier(splitMeta.exporterIdent), // as what name it should be exported as
              ),
            ]),
          ])
        })

        // convert exports to imports from the original file
        programPath.traverse({
          ExportNamedDeclaration(path) {
            // e.g. export const x = 1 or export { x }
            // becomes
            // import { x } from '${opts.id}'

            if (path.node.declaration) {
              if (t.isVariableDeclaration(path.node.declaration)) {
                path.replaceWith(
                  t.importDeclaration(
                    path.node.declaration.declarations.map((decl) =>
                      t.importSpecifier(
                        t.identifier((decl.id as any).name),
                        t.identifier((decl.id as any).name),
                      ),
                    ),
                    t.stringLiteral(
                      removeSplitSearchParamFromFilename(opts.filename),
                    ),
                  ),
                )
              }
            }
          },
        })
      },
    },
  })

  deadCodeElimination(ast, refIdents)

  // if there are exported identifiers, then we need to add a warning
  // to the file to let the user know that the exported identifiers
  // will not in the split file but in the original file, therefore
  // increasing the bundle size
  if (knownExportedIdents.size > 0) {
    const list = Array.from(knownExportedIdents).reduce((str, ident) => {
      str += `\n- ${ident}`
      return str
    }, '')

    const warningMessage = `These exports from "${opts.filename}" are not being code-split and will increase your bundle size: ${list}\nThese should either have their export statements removed or be imported from another file that is not a route.`
    console.warn(warningMessage)

    // append this warning to the file using a template
    if (process.env.NODE_ENV !== 'production') {
      const warningTemplate = template.statement(
        `console.warn(${JSON.stringify(warningMessage)})`,
      )()
      ast.program.body.unshift(warningTemplate)
    }
  }

  return generateFromAst(ast, {
    sourceMaps: true,
    sourceFileName: opts.filename,
    filename: opts.filename,
  })
}

/**
 * This function should read get the options from by searching for the key `codeSplitGroupings`
 * on createFileRoute and return it's values if it exists, else return undefined
 */
export function detectCodeSplitGroupingsFromRoute(opts: ParseAstOptions): {
  groupings: CodeSplitGroupings | undefined
} {
  const ast = parseAst(opts)

  let codeSplitGroupings: CodeSplitGroupings | undefined = undefined

  babel.traverse(ast, {
    Program: {
      enter(programPath) {
        programPath.traverse({
          CallExpression(path) {
            if (!t.isIdentifier(path.node.callee)) {
              return
            }

            if (
              !(
                path.node.callee.name === 'createRoute' ||
                path.node.callee.name === 'createFileRoute'
              )
            ) {
              return
            }

            function babelHandleSplittingGroups(
              routeOptions: t.Node | undefined,
            ) {
              if (t.isObjectExpression(routeOptions)) {
                routeOptions.properties.forEach((prop) => {
                  if (t.isObjectProperty(prop)) {
                    if (t.isIdentifier(prop.key)) {
                      if (prop.key.name === 'codeSplitGroupings') {
                        const value = prop.value

                        if (t.isArrayExpression(value)) {
                          codeSplitGroupings = value.elements.map((group) => {
                            if (t.isArrayExpression(group)) {
                              return group.elements.map((node) => {
                                if (!t.isStringLiteral(node)) {
                                  throw new Error(
                                    'You must provide a string literal for the codeSplitGroupings',
                                  )
                                }

                                return node.value
                              }) as Array<SplitRouteIdentNodes>
                            }

                            throw new Error(
                              'You must provide arrays with codeSplitGroupings options.',
                            )
                          })
                        } else {
                          throw new Error(
                            'You must provide an array of arrays for the codeSplitGroupings.',
                          )
                        }
                      }
                    }
                  }
                })
              }
            }

            // Extracting the codeSplitGroupings
            if (t.isCallExpression(path.parentPath.node)) {
              // createFileRoute('/')({ ... })
              const options = resolveIdentifier(
                path,
                path.parentPath.node.arguments[0],
              )

              babelHandleSplittingGroups(options)
            } else if (t.isVariableDeclarator(path.parentPath.node)) {
              // createFileRoute({ ... })
              const caller = resolveIdentifier(path, path.parentPath.node.init)

              if (t.isCallExpression(caller)) {
                const options = resolveIdentifier(path, caller.arguments[0])
                babelHandleSplittingGroups(options)
              }
            }
          },
        })
      },
    },
  })

  return { groupings: codeSplitGroupings }
}

function getImportSpecifierAndPathFromLocalName(
  programPath: babel.NodePath<t.Program>,
  name: string,
): {
  specifier:
    | t.ImportSpecifier
    | t.ImportDefaultSpecifier
    | t.ImportNamespaceSpecifier
    | null
  path: string | null
} {
  let specifier:
    | t.ImportSpecifier
    | t.ImportDefaultSpecifier
    | t.ImportNamespaceSpecifier
    | null = null
  let path: string | null = null

  programPath.traverse({
    ImportDeclaration(importPath) {
      const found = importPath.node.specifiers.find(
        (targetSpecifier) => targetSpecifier.local.name === name,
      )
      if (found) {
        specifier = found
        path = importPath.node.source.value
      }
    },
  })

  return { specifier, path }
}

// Reusable function to get literal value or resolve variable to literal
function resolveIdentifier(path: any, node: any): t.Node | undefined {
  if (t.isIdentifier(node)) {
    const binding = path.scope.getBinding(node.name)
    if (
      binding
      // && binding.kind === 'const'
    ) {
      const declarator = binding.path.node
      if (t.isObjectExpression(declarator.init)) {
        return declarator.init
      } else if (t.isFunctionDeclaration(declarator.init)) {
        return declarator.init
      }
    }
    return undefined
  }

  return node
}

function removeIdentifierLiteral(path: babel.NodePath, node: t.Identifier) {
  const binding = path.scope.getBinding(node.name)
  if (binding) {
    binding.path.remove()
  }
}

function hasExport(ast: t.File, node: t.Identifier): boolean {
  let found = false

  babel.traverse(ast, {
    ExportNamedDeclaration(path) {
      if (path.node.declaration) {
        // declared as `const loaderFn = () => {}`
        if (t.isVariableDeclaration(path.node.declaration)) {
          path.node.declaration.declarations.forEach((decl) => {
            if (t.isVariableDeclarator(decl)) {
              if (t.isIdentifier(decl.id)) {
                if (decl.id.name === node.name) {
                  found = true
                }
              }
            }
          })
        }

        // declared as `function loaderFn() {}`
        if (t.isFunctionDeclaration(path.node.declaration)) {
          if (t.isIdentifier(path.node.declaration.id)) {
            if (path.node.declaration.id.name === node.name) {
              found = true
            }
          }
        }
      }
    },
    ExportDefaultDeclaration(path) {
      // declared as `export default loaderFn`
      if (t.isIdentifier(path.node.declaration)) {
        if (path.node.declaration.name === node.name) {
          found = true
        }
      }

      // declared as `export default function loaderFn() {}`
      if (t.isFunctionDeclaration(path.node.declaration)) {
        if (t.isIdentifier(path.node.declaration.id)) {
          if (path.node.declaration.id.name === node.name) {
            found = true
          }
        }
      }
    },
  })

  return found
}

function removeExports(ast: t.File, node: t.Identifier): boolean {
  let removed = false

  // The checks use sequential if/else if statements since it
  // directly mutates the AST and as such doing normal checks
  // (using only if statements) could lead to a situation where
  // `path.node` is null since it has been already removed from
  // the program tree but typescript doesn't know that.
  babel.traverse(ast, {
    ExportNamedDeclaration(path) {
      if (path.node.declaration) {
        if (t.isVariableDeclaration(path.node.declaration)) {
          // declared as `const loaderFn = () => {}`
          path.node.declaration.declarations.forEach((decl) => {
            if (t.isVariableDeclarator(decl)) {
              if (t.isIdentifier(decl.id)) {
                if (decl.id.name === node.name) {
                  path.remove()
                  removed = true
                }
              }
            }
          })
        } else if (t.isFunctionDeclaration(path.node.declaration)) {
          // declared as `export const loaderFn = () => {}`
          if (t.isIdentifier(path.node.declaration.id)) {
            if (path.node.declaration.id.name === node.name) {
              path.remove()
              removed = true
            }
          }
        }
      }
    },
    ExportDefaultDeclaration(path) {
      // declared as `export default loaderFn`
      if (t.isIdentifier(path.node.declaration)) {
        if (path.node.declaration.name === node.name) {
          path.remove()
          removed = true
        }
      } else if (t.isFunctionDeclaration(path.node.declaration)) {
        // declared as `export default function loaderFn() {}`
        if (t.isIdentifier(path.node.declaration.id)) {
          if (path.node.declaration.id.name === node.name) {
            path.remove()
            removed = true
          }
        }
      }
    },
  })

  return removed
}
