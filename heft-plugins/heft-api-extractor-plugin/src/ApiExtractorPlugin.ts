// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type * as TApiExtractor from '@microsoft/api-extractor';
import type {
  IHeftTaskPlugin,
  IHeftTaskRunHookOptions,
  IHeftTaskSession,
  HeftConfiguration,
  IHeftTaskCleanHookOptions
} from '@rushstack/heft';
import { ConfigurationFile } from '@rushstack/heft-config-file';

import { ApiExtractorRunner } from './ApiExtractorRunner';

// eslint-disable-next-line @rushstack/no-new-null
const UNINITIALIZED: null = null;

const PLUGIN_NAME: string = 'ApiExtractorPlugin';
const TASK_CONFIG_SCHEMA_PATH: string = `${__dirname}/schemas/api-extractor-task.schema.json`;
const TASK_CONFIG_RELATIVE_PATH: string = './config/api-extractor-task.json';
const EXTRACTOR_CONFIG_FILENAME: typeof TApiExtractor.ExtractorConfig.FILENAME = 'api-extractor.json';
const LEGACY_EXTRACTOR_CONFIG_RELATIVE_PATH: string = `./${EXTRACTOR_CONFIG_FILENAME}`;
const EXTRACTOR_CONFIG_RELATIVE_PATH: string = `./config/${EXTRACTOR_CONFIG_FILENAME}`;

export interface IApiExtractorConfigurationResult {
  apiExtractorPackage: typeof TApiExtractor;
  apiExtractorConfiguration: TApiExtractor.ExtractorConfig;
}

export interface IApiExtractorTaskConfiguration {
  /**
   * If set to true, use the project's TypeScript compiler version for API Extractor's
   * analysis. API Extractor's included TypeScript compiler can generally correctly
   * analyze typings generated by older compilers, and referencing the project's compiler
   * can cause issues. If issues are encountered with API Extractor's included compiler,
   * set this option to true.
   *
   * This corresponds to API Extractor's `--typescript-compiler-folder` CLI option and
   * `IExtractorInvokeOptions.typescriptCompilerFolder` API option. This option defaults to false.
   */
  useProjectTypescriptVersion?: boolean;
}

export default class ApiExtractorPlugin implements IHeftTaskPlugin {
  private _apiExtractor: typeof TApiExtractor | undefined;
  private _apiExtractorConfigurationFilePath: string | undefined | typeof UNINITIALIZED = UNINITIALIZED;
  private _apiExtractorTaskConfigurationFileLoader:
    | ConfigurationFile<IApiExtractorTaskConfiguration>
    | undefined;

  public apply(taskSession: IHeftTaskSession, heftConfiguration: HeftConfiguration): void {
    taskSession.hooks.clean.tapPromise(PLUGIN_NAME, async (cleanOptions: IHeftTaskCleanHookOptions) => {
      // Load up the configuration, but ignore if target files are missing, since we will be deleting
      // them anyway.
      const result: IApiExtractorConfigurationResult | undefined =
        await this._getApiExtractorConfigurationAsync(
          taskSession,
          heftConfiguration,
          /* ignoreMissingEntryPoint: */ true
        );
      if (result) {
        this._includeOutputPathsInClean(cleanOptions, result.apiExtractorConfiguration);
      }
    });

    taskSession.hooks.run.tapPromise(PLUGIN_NAME, async (runOptions: IHeftTaskRunHookOptions) => {
      const result: IApiExtractorConfigurationResult | undefined =
        await this._getApiExtractorConfigurationAsync(taskSession, heftConfiguration);
      if (result) {
        await this._runApiExtractorAsync(
          taskSession,
          heftConfiguration,
          runOptions,
          result.apiExtractorPackage,
          result.apiExtractorConfiguration
        );
      }
    });
  }

  private async _getApiExtractorConfigurationFilePathAsync(
    taskSession: IHeftTaskSession,
    heftConfiguration: HeftConfiguration
  ): Promise<string | undefined> {
    if (this._apiExtractorConfigurationFilePath === UNINITIALIZED) {
      this._apiExtractorConfigurationFilePath =
        await heftConfiguration.rigConfig.tryResolveConfigFilePathAsync(EXTRACTOR_CONFIG_RELATIVE_PATH);
      if (this._apiExtractorConfigurationFilePath === undefined) {
        this._apiExtractorConfigurationFilePath =
          await heftConfiguration.rigConfig.tryResolveConfigFilePathAsync(
            LEGACY_EXTRACTOR_CONFIG_RELATIVE_PATH
          );
        if (this._apiExtractorConfigurationFilePath !== undefined) {
          taskSession.logger.emitWarning(
            new Error(
              `The "${LEGACY_EXTRACTOR_CONFIG_RELATIVE_PATH}" configuration file path is not supported ` +
                `in Heft. Please move it to "${EXTRACTOR_CONFIG_RELATIVE_PATH}".`
            )
          );
        }
      }
    }
    return this._apiExtractorConfigurationFilePath;
  }

  private async _getApiExtractorConfigurationAsync(
    taskSession: IHeftTaskSession,
    heftConfiguration: HeftConfiguration,
    ignoreMissingEntryPoint?: boolean
  ): Promise<IApiExtractorConfigurationResult | undefined> {
    // API Extractor provides an ExtractorConfig.tryLoadForFolder() API that will probe for api-extractor.json
    // including support for rig.json.  However, Heft does not load the @microsoft/api-extractor package at all
    // unless it sees a config/api-extractor.json file.  Thus we need to do our own lookup here.
    const apiExtractorConfigurationFilePath: string | undefined =
      await this._getApiExtractorConfigurationFilePathAsync(taskSession, heftConfiguration);
    if (!apiExtractorConfigurationFilePath) {
      return undefined;
    }

    // Since the config file exists, we can assume that API Extractor is available. Attempt to resolve
    // and import the package. If the resolution fails, a helpful error is thrown.
    const apiExtractorPackage: typeof TApiExtractor = await this._getApiExtractorPackageAsync(
      taskSession,
      heftConfiguration
    );
    const apiExtractorConfigurationObject: TApiExtractor.IConfigFile =
      apiExtractorPackage.ExtractorConfig.loadFile(apiExtractorConfigurationFilePath);

    // Load the configuration file. Always load from scratch.
    const apiExtractorConfiguration: TApiExtractor.ExtractorConfig =
      apiExtractorPackage.ExtractorConfig.prepare({
        ignoreMissingEntryPoint,
        configObject: apiExtractorConfigurationObject,
        configObjectFullPath: apiExtractorConfigurationFilePath,
        packageJsonFullPath: `${heftConfiguration.buildFolder}/package.json`,
        projectFolderLookupToken: heftConfiguration.buildFolder
      });

    return { apiExtractorPackage, apiExtractorConfiguration };
  }

  private async _getApiExtractorPackageAsync(
    taskSession: IHeftTaskSession,
    heftConfiguration: HeftConfiguration
  ): Promise<typeof TApiExtractor> {
    if (!this._apiExtractor) {
      const apiExtractorPackagePath: string = await heftConfiguration.rigPackageResolver.resolvePackageAsync(
        '@microsoft/api-extractor',
        taskSession.logger.terminal
      );
      this._apiExtractor = (await import(apiExtractorPackagePath)) as typeof TApiExtractor;
    }
    return this._apiExtractor;
  }

  private async _getApiExtractorTaskConfigurationAsync(
    taskSession: IHeftTaskSession,
    heftConfiguration: HeftConfiguration
  ): Promise<IApiExtractorTaskConfiguration | undefined> {
    if (!this._apiExtractorTaskConfigurationFileLoader) {
      this._apiExtractorTaskConfigurationFileLoader = new ConfigurationFile<IApiExtractorTaskConfiguration>({
        projectRelativeFilePath: TASK_CONFIG_RELATIVE_PATH,
        jsonSchemaPath: TASK_CONFIG_SCHEMA_PATH
      });
    }

    return await this._apiExtractorTaskConfigurationFileLoader.tryLoadConfigurationFileForProjectAsync(
      taskSession.logger.terminal,
      heftConfiguration.buildFolder,
      heftConfiguration.rigConfig
    );
  }

  private _includeOutputPathsInClean(
    cleanOptions: IHeftTaskCleanHookOptions,
    apiExtractorConfiguration: TApiExtractor.ExtractorConfig
  ): void {
    const extractorGeneratedFilePaths: string[] = [];
    if (apiExtractorConfiguration.apiReportEnabled) {
      // Keep apiExtractorConfiguration.reportFilePath as-is, since API-Extractor uses the existing
      // content to write a warning if the output has changed.
      extractorGeneratedFilePaths.push(apiExtractorConfiguration.reportTempFilePath);
    }
    if (apiExtractorConfiguration.docModelEnabled) {
      extractorGeneratedFilePaths.push(apiExtractorConfiguration.apiJsonFilePath);
    }
    if (apiExtractorConfiguration.rollupEnabled) {
      extractorGeneratedFilePaths.push(
        apiExtractorConfiguration.alphaTrimmedFilePath,
        apiExtractorConfiguration.betaTrimmedFilePath,
        apiExtractorConfiguration.publicTrimmedFilePath,
        apiExtractorConfiguration.untrimmedFilePath
      );
    }
    if (apiExtractorConfiguration.tsdocMetadataEnabled) {
      extractorGeneratedFilePaths.push(apiExtractorConfiguration.tsdocMetadataFilePath);
    }

    for (const generatedFilePath of extractorGeneratedFilePaths) {
      if (generatedFilePath) {
        cleanOptions.addDeleteOperations({ sourcePath: generatedFilePath });
      }
    }
  }

  private async _runApiExtractorAsync(
    taskSession: IHeftTaskSession,
    heftConfiguration: HeftConfiguration,
    runOptions: IHeftTaskRunHookOptions,
    apiExtractor: typeof TApiExtractor,
    apiExtractorConfiguration: TApiExtractor.ExtractorConfig
  ): Promise<void> {
    // TODO: Handle watch mode
    // if (watchMode) {
    //   taskSession.logger.terminal.writeWarningLine("API Extractor isn't currently supported in --watch mode.");
    //   return;
    // }

    const apiExtractorTaskConfiguration: IApiExtractorTaskConfiguration | undefined =
      await this._getApiExtractorTaskConfigurationAsync(taskSession, heftConfiguration);

    let typescriptPackagePath: string | undefined;
    if (apiExtractorTaskConfiguration?.useProjectTypescriptVersion) {
      typescriptPackagePath = await heftConfiguration.rigPackageResolver.resolvePackageAsync(
        'typescript',
        taskSession.logger.terminal
      );
    }

    const apiExtractorRunner: ApiExtractorRunner = new ApiExtractorRunner({
      apiExtractor,
      apiExtractorConfiguration,
      typescriptPackagePath,
      buildFolder: heftConfiguration.buildFolder,
      production: runOptions.production,
      scopedLogger: taskSession.logger
    });

    // Run API Extractor
    await apiExtractorRunner.invokeAsync();
  }
}
