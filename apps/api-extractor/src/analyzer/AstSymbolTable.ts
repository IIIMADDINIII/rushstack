// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/* tslint:disable:no-bitwise */

import * as ts from 'typescript';
import { PackageJsonLookup, InternalError } from '@microsoft/node-core-library';

import { AstDeclaration } from './AstDeclaration';
import { SymbolAnalyzer } from './SymbolAnalyzer';
import { TypeScriptHelpers } from './TypeScriptHelpers';
import { AstSymbol } from './AstSymbol';
import { AstImport, IAstImportOptions } from './AstImport';
import { AstModule } from './AstModule';
import { PackageMetadataManager } from './PackageMetadataManager';
import { ILogger } from '../api/ILogger';

/**
 * AstSymbolTable is the workhorse that builds AstSymbol and AstDeclaration objects.
 * It maintains a cache of already constructed objects.  AstSymbolTable constructs
 * AstModule objects, but otherwise the state that it maintains  is agnostic of
 * any particular entry point.  (For example, it does not track whether a given AstSymbol
 * is "exported" or not.)
 */
export class AstSymbolTable {
  private readonly _program: ts.Program;
  private readonly _typeChecker: ts.TypeChecker;
  private readonly _packageMetadataManager: PackageMetadataManager;

  /**
   * A mapping from ts.Symbol --> AstSymbol
   * NOTE: The AstSymbol.followedSymbol will always be a lookup key, but additional keys
   * are possible.
   *
   * After following type aliases, we use this map to look up the corresponding AstSymbol.
   */
  private readonly _astSymbolsBySymbol: Map<ts.Symbol, AstSymbol> = new Map<ts.Symbol, AstSymbol>();

  /**
   * A mapping from ts.Declaration --> AstDeclaration
   */
  private readonly _astDeclarationsByDeclaration: Map<ts.Node, AstDeclaration>
    = new Map<ts.Node, AstDeclaration>();

  /**
   * A mapping from AstImport.key --> AstSymbol.
   *
   * If AstSymbol.astImport is undefined, then it is not included in the map.
   */
  private readonly _astSymbolsByImportKey: Map<string, AstSymbol> = new Map<string, AstSymbol>();

  /**
   * Cache of fetchEntryPoint() results.
   */
  private readonly _astModulesBySourceFile: Map<ts.SourceFile, AstModule>
    = new Map<ts.SourceFile, AstModule>();

  public constructor(program: ts.Program, typeChecker: ts.TypeChecker, packageJsonLookup: PackageJsonLookup,
    logger: ILogger) {

    this._program = program;
    this._typeChecker = typeChecker;
    this._packageMetadataManager = new PackageMetadataManager(packageJsonLookup, logger);
  }

  /**
   * For a given source file, this analyzes all of its exports and produces an AstModule
   * object.
   */
  public fetchAstModuleBySourceFile(sourceFile: ts.SourceFile, moduleSpecifier: string | undefined): AstModule {
    // Don't traverse into a module that we already processed before:
    // The compiler allows m1 to have "export * from 'm2'" and "export * from 'm3'",
    // even if m2 and m3 both have "export * from 'm4'".
    let astModule: AstModule | undefined = this._astModulesBySourceFile.get(sourceFile);

    if (!astModule) {
      astModule = new AstModule(sourceFile);
      this._astModulesBySourceFile.set(sourceFile, astModule);

      const moduleSymbol: ts.Symbol = TypeScriptHelpers.getSymbolForDeclaration(sourceFile);

      // Match:       "@microsoft/sp-lodash-subset" or "lodash/has"
      // but ignore:  "../folder/LocalFile"
      if (moduleSpecifier !== undefined && !ts.isExternalModuleNameRelative(moduleSpecifier)) {
        // Yes, this is the entry point for an external package.
        astModule.externalModulePath = moduleSpecifier;

        for (const exportedSymbol of this._typeChecker.getExportsOfModule(moduleSymbol)) {

          const astImportOptions: IAstImportOptions = {
            exportName: exportedSymbol.name,
            modulePath: astModule.externalModulePath
          };

          const followedSymbol: ts.Symbol = TypeScriptHelpers.followAliases(exportedSymbol, this._typeChecker);
          const astSymbol: AstSymbol | undefined = this._fetchAstSymbol(followedSymbol, true, astImportOptions);

          if (!astSymbol) {
            throw new Error('Unsupported export: ' + exportedSymbol.name);
          }

          astModule.exportedSymbols.set(exportedSymbol.name, astSymbol);
        }
      } else {

        if (moduleSymbol.exports) {
          for (const exportedSymbol of moduleSymbol.exports.values() as IterableIterator<ts.Symbol>) {

            if (exportedSymbol.escapedName === ts.InternalSymbolName.ExportStar) {
              // Special handling for "export * from 'module-name';" declarations, which are all attached to a single
              // symbol whose name is InternalSymbolName.ExportStar
              for (const exportStarDeclaration of exportedSymbol.getDeclarations() || []) {
                this._collectExportsFromExportStar(astModule, exportStarDeclaration);
              }

            } else {
              this._collectExportForAstModule(astModule, exportedSymbol);
            }
          }

        }

      }
    }

    return astModule;
  }

  private _collectExportForAstModule(astModule: AstModule, exportedSymbol: ts.Symbol): void {
    let current: ts.Symbol = exportedSymbol;

    while (true) { // tslint:disable-line:no-constant-condition

      // Is this symbol an import/export that we need to follow to find the real declaration?
      for (const declaration of current.declarations || []) {
        const exportDeclaration: ts.ExportDeclaration | undefined
          = TypeScriptHelpers.findFirstParent<ts.ExportDeclaration>(declaration, ts.SyntaxKind.ExportDeclaration);

        if (exportDeclaration) {
          let exportName: string;

          if (declaration.kind === ts.SyntaxKind.ExportSpecifier) {
            // EXAMPLE:
            // "export { A } from './file-a';"
            //
            // ExportDeclaration:
            //   ExportKeyword:  pre=[export] sep=[ ]
            //   NamedExports:
            //     FirstPunctuation:  pre=[{] sep=[ ]
            //     SyntaxList:
            //       ExportSpecifier:  <------------- declaration
            //         Identifier:  pre=[A] sep=[ ]
            //     CloseBraceToken:  pre=[}] sep=[ ]
            //   FromKeyword:  pre=[from] sep=[ ]
            //   StringLiteral:  pre=['./file-a']
            //   SemicolonToken:  pre=[;]

            // Example: " ExportName as RenamedName"
            const exportSpecifier: ts.ExportSpecifier = declaration as ts.ExportSpecifier;
            exportName = (exportSpecifier.propertyName || exportSpecifier.name).getText().trim();
          } else {
            throw new Error('Unimplemented export declaration kind: ' + declaration.getText());
          }

          const specifierAstModule: AstModule | undefined = this._fetchSpecifierAstModule(exportDeclaration);

          if (specifierAstModule !== undefined) {
            const exportedAstSymbol: AstSymbol | undefined = this._getExportOfAstModule(exportName, specifierAstModule);
            if (exportedAstSymbol !== undefined) {
              astModule.exportedSymbols.set(exportedSymbol.name, exportedAstSymbol);
              return;
            }
          }

        }
      }

      if (!(current.flags & ts.SymbolFlags.Alias)) {
        break;
      }

      const currentAlias: ts.Symbol = TypeScriptHelpers.getImmediateAliasedSymbol(current, this._typeChecker);
      // Stop if we reach the end of the chain
      if (!currentAlias || currentAlias === current) {
        break;
      }

      current = currentAlias;
    }

    // Otherwise, assume it is a normal declaration
    const fetchedAstSymbol: AstSymbol | undefined = this._fetchAstSymbol(current, true, undefined);
    if (fetchedAstSymbol !== undefined) {
      astModule.exportedSymbols.set(exportedSymbol.name, fetchedAstSymbol);
    }
  }

  private _getExportOfAstModule(exportName: string, astModule: AstModule): AstSymbol {
    const visitedAstModules: Set<AstModule> = new Set<AstModule>();
    const astSymbol: AstSymbol | undefined = this._tryGetExportOfAstModule(exportName, astModule, visitedAstModules);
    if (astSymbol === undefined) {
      throw new InternalError(`Unable to analyze the export ${JSON.stringify(exportName)}`);
    }
    return astSymbol;
  }

  private _tryGetExportOfAstModule(exportName: string, astModule: AstModule,
    visitedAstModules: Set<AstModule>): AstSymbol | undefined {

    if (visitedAstModules.has(astModule)) {
      return undefined;
    }
    visitedAstModules.add(astModule);

    let astSymbol: AstSymbol | undefined = astModule.exportedSymbols.get(exportName);
    if (astSymbol !== undefined) {
      return astSymbol;
    }

    // Try each of the star imports
    for (const starExportedModule of astModule.starExportedModules) {
      astSymbol = this._tryGetExportOfAstModule(exportName, starExportedModule, visitedAstModules);
      if (astSymbol !== undefined) {
        return astSymbol;
      }
    }

    return undefined;
  }

  private _collectExportsFromExportStar(astModule: AstModule, exportStarDeclaration: ts.Declaration): void {
    if (ts.isExportDeclaration(exportStarDeclaration)) {

      const starExportedModule: AstModule | undefined = this._fetchSpecifierAstModule(exportStarDeclaration);
      if (starExportedModule !== undefined) {
        astModule.starExportedModules.add(starExportedModule);
      }

    } else {
      // Ignore ExportDeclaration nodes that don't match the expected pattern
      // TODO: Should we report a warning?
    }
  }

  private _fetchSpecifierAstModule(exportStarDeclaration: ts.ImportDeclaration | ts.ExportDeclaration): AstModule
    | undefined {

    // The name of the module, which could be like "./SomeLocalFile' or like 'external-package/entry/point'
    const moduleSpecifier: string | undefined = TypeScriptHelpers.getModuleSpecifier(exportStarDeclaration);
    if (!moduleSpecifier) {
      // TODO: Should we report a warning?
      return;
    }

    const resolvedModule: ts.ResolvedModuleFull | undefined = TypeScriptHelpers.getResolvedModule(
      exportStarDeclaration.getSourceFile(), moduleSpecifier);

    if (resolvedModule === undefined) {
      // This should not happen, since getResolvedModule() specifically looks up names that the compiler
      // found in export declarations for this source file
      throw new InternalError('getResolvedModule() could not resolve module name ' + JSON.stringify(moduleSpecifier));
    }

    // Map the filename back to the corresponding SourceFile. This circuitous approach is needed because
    // we have no way to access the compiler's internal resolveExternalModuleName() function
    const moduleSourceFile: ts.SourceFile | undefined = this._program.getSourceFile(resolvedModule.resolvedFileName);
    if (!moduleSourceFile) {
      // This should not happen, since getResolvedModule() specifically looks up names that the compiler
      // found in export declarations for this source file
      throw new InternalError('getSourceFile() failed to locate ' + JSON.stringify(resolvedModule.resolvedFileName));
    }

    const specifierAstModule: AstModule = this.fetchAstModuleBySourceFile(moduleSourceFile, moduleSpecifier);
    return specifierAstModule;
  }

  /**
   * Ensures that AstSymbol.analyzed is true for the provided symbol.  The operation
   * starts from the root symbol and then fills out all children of all declarations, and
   * also calculates AstDeclaration.referencedAstSymbols for all declarations.
   * If the symbol is not imported, any non-imported references are also analyzed.
   * @remarks
   * This is an expensive operation, so we only perform it for top-level exports of an
   * the AstModule.  For example, if some code references a nested class inside
   * a namespace from another library, we do not analyze any of that class's siblings
   * or members.  (We do always construct its parents however, since AstDefinition.parent
   * is immutable, and needed e.g. to calculate release tag inheritance.)
   */
  public analyze(astSymbol: AstSymbol): void {
    if (astSymbol.analyzed) {
      return;
    }

    if (astSymbol.nominal) {
      // We don't analyze nominal symbols
      astSymbol._notifyAnalyzed();
      return;
    }

    // Start at the root of the tree
    const rootAstSymbol: AstSymbol = astSymbol.rootAstSymbol;

    // Calculate the full child tree for each definition
    for (const astDeclaration of rootAstSymbol.astDeclarations) {
      this._analyzeChildTree(astDeclaration.declaration, astDeclaration);
    }

    rootAstSymbol._notifyAnalyzed();

    if (!astSymbol.astImport) {
      // If this symbol is not imported, then we also analyze any referencedAstSymbols
      // that are not imported.  For example, this ensures that forgotten exports get
      // analyzed.
      rootAstSymbol.forEachDeclarationRecursive((astDeclaration: AstDeclaration) => {
        for (const referencedAstSymbol of astDeclaration.referencedAstSymbols) {
          // Walk up to the root of the tree, looking for any imports along the way
          if (!referencedAstSymbol.imported) {
            this.analyze(referencedAstSymbol);
          }
        }
      });
    }
  }

  /**
   * Looks up the AstSymbol corresponding to the given ts.Symbol.
   * This will not analyze or construct any new AstSymbol objects.
   */
  public tryGetAstSymbol(symbol: ts.Symbol): AstSymbol | undefined {
    return this._fetchAstSymbol(symbol, false, undefined);
  }

  /**
   * For a given astDeclaration, this efficiently finds the child corresponding to the
   * specified ts.Node.  It is assumed that isAstDeclaration() would return true for
   * that node type, and that the node is an immediate child of the provided AstDeclaration.
   */
  // NOTE: This could be a method of AstSymbol if it had a backpointer to its AstSymbolTable.
  public getChildAstDeclarationByNode(node: ts.Node, parentAstDeclaration: AstDeclaration): AstDeclaration {
    if (!parentAstDeclaration.astSymbol.analyzed) {
      throw new Error('getChildDeclarationByNode() cannot be used for an AstSymbol that was not analyzed');
    }

    const childAstDeclaration: AstDeclaration | undefined = this._astDeclarationsByDeclaration.get(node);
    if (!childAstDeclaration) {
      throw new Error('Child declaration not found for the specified node');
    }
    if (childAstDeclaration.parent !== parentAstDeclaration) {
      throw new InternalError('The found child is not attached to the parent AstDeclaration');
    }

    return childAstDeclaration;
  }

  /**
   * Used by analyze to recursively analyze the entire child tree.
   */
  private _analyzeChildTree(node: ts.Node, governingAstDeclaration: AstDeclaration): void {
    switch (node.kind) {
      case ts.SyntaxKind.JSDocComment: // Skip JSDoc comments - TS considers @param tags TypeReference nodes
        return;

      // is this a reference to another AstSymbol?
      case ts.SyntaxKind.TypeReference: // general type references
      case ts.SyntaxKind.ExpressionWithTypeArguments: // special case for e.g. the "extends" keyword
      case ts.SyntaxKind.ComputedPropertyName:  // used for EcmaScript "symbols", e.g. "[toPrimitive]".
        {
          // Sometimes the type reference will involve multiple identifiers, e.g. "a.b.C".
          // In this case, we only need to worry about importing the first identifier,
          // so do a depth-first search for it:
          const symbolNode: ts.Node | undefined = TypeScriptHelpers.findFirstChildNode(
            node, ts.SyntaxKind.Identifier);

          if (!symbolNode) {
            break;
          }

          const symbol: ts.Symbol | undefined = this._typeChecker.getSymbolAtLocation(symbolNode);
          if (!symbol) {
            throw new Error('Symbol not found for identifier: ' + symbolNode.getText());
          }

          const referencedAstSymbol: AstSymbol | undefined = this._fetchAstSymbol(symbol, true, undefined);
          if (referencedAstSymbol) {
            governingAstDeclaration._notifyReferencedAstSymbol(referencedAstSymbol);
          }
        }
        break;
    }

    // Is this node declaring a new AstSymbol?
    const newGoverningAstDeclaration: AstDeclaration | undefined = this._fetchAstDeclaration(node);

    for (const childNode of node.getChildren()) {
      this._analyzeChildTree(childNode, newGoverningAstDeclaration || governingAstDeclaration);
    }
  }

  // tslint:disable-next-line:no-unused-variable
  private _fetchAstDeclaration(node: ts.Node): AstDeclaration | undefined {
    const astSymbol: AstSymbol | undefined = this._fetchAstSymbolForNode(node);
    if (!astSymbol) {
      return undefined;
    }

    const astDeclaration: AstDeclaration | undefined
      = this._astDeclarationsByDeclaration.get(node);
    if (!astDeclaration) {
      throw new InternalError('Unable to find constructed AstDeclaration');
    }

    return astDeclaration;
  }

  private _fetchAstSymbolForNode(node: ts.Node): AstSymbol | undefined {
    if (!SymbolAnalyzer.isAstDeclaration(node.kind)) {
      return undefined;
    }

    const symbol: ts.Symbol | undefined = TypeScriptHelpers.getSymbolForDeclaration(node as ts.Declaration);
    if (!symbol) {
      throw new InternalError('Unable to find symbol for node');
    }

    return this._fetchAstSymbol(symbol, true, undefined);
  }

  private _fetchAstSymbol(followedSymbol: ts.Symbol, addIfMissing: boolean,
    astImportOptions: IAstImportOptions | undefined): AstSymbol | undefined {

    // Filter out symbols representing constructs that we don't care about
    if (followedSymbol.flags & (ts.SymbolFlags.TypeParameter | ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.Transient)) {
      return undefined;
    }

    if (SymbolAnalyzer.isAmbient(followedSymbol, this._typeChecker)) {
      // API Extractor doesn't analyze ambient declarations at all
      return undefined;
    }

    let astSymbol: AstSymbol | undefined = this._astSymbolsBySymbol.get(followedSymbol);

    if (!astSymbol) {
      if (!followedSymbol.declarations || followedSymbol.declarations.length < 1) {
        throw new InternalError('Followed a symbol with no declarations');
      }

      const astImport: AstImport | undefined = astImportOptions ? new AstImport(astImportOptions) : undefined;

      if (astImport) {
        if (!astSymbol) {
          astSymbol = this._astSymbolsByImportKey.get(astImport.key);
          if (astSymbol) {
            // We didn't find the entry using followedSymbol, but we did using importPackageKey,
            // so add a mapping for followedSymbol; we'll need it later when renaming identifiers
            this._astSymbolsBySymbol.set(followedSymbol, astSymbol);
          }
        }
      }

      if (!astSymbol) {
        // None of the above lookups worked, so create a new entry...
        let nominal: boolean = false;

        // NOTE: In certain circumstances we need an AstSymbol for a source file that is acting
        // as a TypeScript module.  For example, one of the unit tests has this line:
        //
        //   import * as semver1 from 'semver';
        //
        // To handle the expression "semver1.SemVer", we need "semver1" to map to an AstSymbol
        // that causes us to emit the above import.  However we do NOT want it to act as the root
        // of a declaration tree, because in general the *.d.ts generator is trying to roll up
        // definitions and eliminate source files.  So, even though isAstDeclaration() would return
        // false, we do create an AstDeclaration for a ts.SyntaxKind.SourceFile in this special edge case.
        if (followedSymbol.declarations.length === 1
          && followedSymbol.declarations[0].kind === ts.SyntaxKind.SourceFile) {
          nominal = true;
        }

        // If the file is from a package that does not support AEDoc, then we process the
        // symbol itself, but we don't attempt to process any parent/children of it.
        const followedSymbolSourceFile: ts.SourceFile = followedSymbol.declarations[0].getSourceFile();
        if (astImport !== undefined) {
          if (!this._packageMetadataManager.isAedocSupportedFor(followedSymbolSourceFile.fileName)) {
            nominal = true;
          }
        }

        let parentAstSymbol: AstSymbol | undefined = undefined;

        if (!nominal) {
          for (const declaration of followedSymbol.declarations || []) {
            if (!SymbolAnalyzer.isAstDeclaration(declaration.kind)) {
              throw new InternalError(`The "${followedSymbol.name}" symbol uses the construct`
                + ` "${ts.SyntaxKind[declaration.kind]}" which may be an unimplemented language feature`);
            }
          }

          // We always fetch the entire chain of parents for each declaration.
          // (Children/siblings are only analyzed on demand.)

          // Key assumptions behind this squirrely logic:
          //
          // IF a given symbol has two declarations D1 and D2; AND
          // If D1 has a parent P1, then
          // - D2 will also have a parent P2; AND
          // - P1 and P2's symbol will be the same
          // - but P1 and P2 may be different (e.g. merged namespaces containing merged interfaces)

          // Is there a parent AstSymbol?  First we check to see if there is a parent declaration:
          const arbitaryParentDeclaration: ts.Node | undefined
            = this._tryFindFirstAstDeclarationParent(followedSymbol.declarations[0]);

          if (arbitaryParentDeclaration) {
            const parentSymbol: ts.Symbol = TypeScriptHelpers.getSymbolForDeclaration(
              arbitaryParentDeclaration as ts.Declaration);

            parentAstSymbol = this._fetchAstSymbol(parentSymbol, addIfMissing, undefined);
            if (!parentAstSymbol) {
              throw new InternalError('Unable to construct a parent AstSymbol for '
                + followedSymbol.name);
            }
          }
        }

        astSymbol = new AstSymbol({
          localName: followedSymbol.name,
          followedSymbol: followedSymbol,
          astImport: astImport,
          parentAstSymbol: parentAstSymbol,
          rootAstSymbol: parentAstSymbol ? parentAstSymbol.rootAstSymbol : undefined,
          nominal: nominal
        });

        this._astSymbolsBySymbol.set(followedSymbol, astSymbol);

        if (astImport) {
          // If it's an import, add it to the lookup
          this._astSymbolsByImportKey.set(astImport.key, astSymbol);
        }

        // Okay, now while creating the declarations we will wire them up to the
        // their corresponding parent declarations
        for (const declaration of followedSymbol.declarations || []) {

          let parentAstDeclaration: AstDeclaration | undefined = undefined;
          if (parentAstSymbol) {
            const parentDeclaration: ts.Node | undefined = this._tryFindFirstAstDeclarationParent(declaration);

            if (!parentDeclaration) {
              throw new InternalError('Missing parent declaration');
            }

            parentAstDeclaration = this._astDeclarationsByDeclaration.get(parentDeclaration);
            if (!parentAstDeclaration) {
              throw new InternalError('Missing parent AstDeclaration');
            }
          }

          const astDeclaration: AstDeclaration = new AstDeclaration({
            declaration, astSymbol, parent: parentAstDeclaration});

          this._astDeclarationsByDeclaration.set(declaration, astDeclaration);
        }
      }
    }

    if (astImportOptions && !astSymbol.imported) {
      // Our strategy for recognizing external declarations is to look for an import statement
      // during SymbolAnalyzer.followAliases().  Although it is sometimes possible to reach a symbol
      // without traversing an import statement, we assume that that the first reference will always
      // involve an import statement.
      //
      // This assumption might be violated if the caller did something unusual like feeding random
      // symbols to AstSymbolTable.analyze() in the middle of the analysis.
      throw new InternalError('The symbol ' + astSymbol.localName + ' is being imported'
        + ' after it was already registered as non-imported');
    }

    return astSymbol;
  }

  /**
   * Returns the first parent satisfying isAstDeclaration(), or undefined if none is found.
   */
  private _tryFindFirstAstDeclarationParent(node: ts.Node): ts.Node | undefined {
    let currentNode: ts.Node | undefined = node.parent;
    while (currentNode) {
      if (SymbolAnalyzer.isAstDeclaration(currentNode.kind)) {
        return currentNode;
      }
      currentNode = currentNode.parent;
    }
    return undefined;
  }
}
