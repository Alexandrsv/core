import type {
  Compiler,
  WebpackPluginInstance,
  Compilation,
  Chunk,
} from 'webpack';
import { normalizeWebpackPath } from '@module-federation/sdk/normalize-webpack-path';
import FederationRuntimeModule from './FederationRuntimeModule';
import type { moduleFederationPlugin } from '@module-federation/sdk';
import {
  getFederationGlobalScope,
  normalizeRuntimeInitOptionsWithOutShared,
  modifyEntry,
  createHash,
  normalizeToPosixPath,
} from './utils';
import fs from 'fs';
import path from 'path';
import { TEMP_DIR } from '../constant';
import EmbedFederationRuntimePlugin from './EmbedFederationRuntimePlugin';
import FederationModulesPlugin from './FederationModulesPlugin';
import HoistContainerReferences from '../HoistContainerReferencesPlugin';
import pBtoa from 'btoa';
import ContainerEntryDependency from '../ContainerEntryDependency';
import FederationRuntimeDependency from './FederationRuntimeDependency';

const ModuleDependency = require(
  normalizeWebpackPath('webpack/lib/dependencies/ModuleDependency'),
) as typeof import('webpack/lib/dependencies/ModuleDependency');

const { RuntimeGlobals, Template } = require(
  normalizeWebpackPath('webpack'),
) as typeof import('webpack');
const { mkdirpSync } = require(
  normalizeWebpackPath('webpack/lib/util/fs'),
) as typeof import('webpack/lib/util/fs');

const RuntimeToolsPath = require.resolve('@module-federation/runtime-tools');

const BundlerRuntimePath = require.resolve(
  '@module-federation/webpack-bundler-runtime',
  {
    paths: [RuntimeToolsPath],
  },
);
const RuntimePath = require.resolve('@module-federation/runtime', {
  paths: [RuntimeToolsPath],
});
const EmbeddedRuntimePath = require.resolve(
  '@module-federation/runtime/embedded',
  {
    paths: [RuntimeToolsPath],
  },
);

const federationGlobal = getFederationGlobalScope(RuntimeGlobals);

const onceForCompler = new WeakSet();

class FederationRuntimePlugin {
  options?: moduleFederationPlugin.ModuleFederationPluginOptions;
  entryFilePath: string;
  bundlerRuntimePath: string;
  federationRuntimeDependency?: FederationRuntimeDependency; // Add this line

  constructor(options?: moduleFederationPlugin.ModuleFederationPluginOptions) {
    this.options = options ? { ...options } : undefined;
    this.entryFilePath = '';
    this.bundlerRuntimePath = BundlerRuntimePath;
    this.federationRuntimeDependency = undefined; // Initialize as undefined
  }

  static getTemplate(
    runtimePlugins: string[],
    bundlerRuntimePath?: string,
    experiments?: moduleFederationPlugin.ModuleFederationPluginOptions['experiments'],
  ) {
    const normalizedBundlerRuntimePath = normalizeToPosixPath(
      bundlerRuntimePath || BundlerRuntimePath,
    );

    let runtimePluginTemplates = '';
    const runtimePluginNames: string[] = [];

    if (Array.isArray(runtimePlugins)) {
      runtimePlugins.forEach((runtimePlugin, index) => {
        const runtimePluginName = `plugin_${index}`;
        const runtimePluginPath = normalizeToPosixPath(
          path.isAbsolute(runtimePlugin)
            ? runtimePlugin
            : path.join(process.cwd(), runtimePlugin),
        );

        runtimePluginTemplates += `import ${runtimePluginName} from '${runtimePluginPath}';\n`;
        runtimePluginNames.push(runtimePluginName);
      });
    }

    const embedRuntimeLines = Template.asString([
      `if(!${federationGlobal}.runtime){`,
      Template.indent([
        `var prevFederation = ${federationGlobal};`,
        `${federationGlobal} = {}`,
        `for(var key in federation){`,
        Template.indent([`${federationGlobal}[key] = federation[key];`]),
        '}',
        `for(var key in prevFederation){`,
        Template.indent([`${federationGlobal}[key] = prevFederation[key];`]),
        '}',
      ]),
      '}',
    ]);

    return Template.asString([
      `import federation from '${normalizedBundlerRuntimePath}';`,
      runtimePluginTemplates,
      embedRuntimeLines,
      `if(!${federationGlobal}.instance){`,
      Template.indent([
        runtimePluginNames.length
          ? Template.asString([
              `const pluginsToAdd = [`,
              Template.indent(
                runtimePluginNames.map(
                  (item) => `${item} ? (${item}.default || ${item})() : false,`,
                ),
              ),
              `].filter(Boolean);`,
              `${federationGlobal}.initOptions.plugins = ${federationGlobal}.initOptions.plugins ? `,
              `${federationGlobal}.initOptions.plugins.concat(pluginsToAdd) : pluginsToAdd;`,
            ])
          : '',
        `${federationGlobal}.instance = ${federationGlobal}.runtime.init(${federationGlobal}.initOptions);`,
        `if(${federationGlobal}.attachShareScopeMap){`,
        Template.indent([
          `${federationGlobal}.attachShareScopeMap(${RuntimeGlobals.require})`,
        ]),
        '}',
        `if(${federationGlobal}.installInitialConsumes){`,
        Template.indent([`${federationGlobal}.installInitialConsumes()`]),
        '}',
      ]),
      '}',
    ]);
  }

  static getFilePath(
    containerName: string,
    runtimePlugins: string[],
    bundlerRuntimePath?: string,
    experiments?: moduleFederationPlugin.ModuleFederationPluginOptions['experiments'],
  ) {
    const hash = createHash(
      `${containerName} ${FederationRuntimePlugin.getTemplate(
        runtimePlugins,
        bundlerRuntimePath,
        experiments,
      )}`,
    );
    return path.join(TEMP_DIR, `entry.${hash}.js`);
  }

  getFilePath() {
    if (this.entryFilePath) {
      return this.entryFilePath;
    }

    if (!this.options) {
      return '';
    }

    if (!this.options?.virtualRuntimeEntry) {
      this.entryFilePath = FederationRuntimePlugin.getFilePath(
        this.options.name!,
        this.options.runtimePlugins!,
        this.bundlerRuntimePath,
        this.options.experiments,
      );
    } else {
      this.entryFilePath = `data:text/javascript;charset=utf-8;base64,${pBtoa(
        FederationRuntimePlugin.getTemplate(
          this.options.runtimePlugins!,
          this.bundlerRuntimePath,
          this.options.experiments,
        ),
      )}`;
    }
    return this.entryFilePath;
  }

  ensureFile() {
    if (!this.options) {
      return;
    }
    const filePath = this.getFilePath();
    try {
      fs.readFileSync(filePath);
    } catch (err) {
      mkdirpSync(fs, TEMP_DIR);
      fs.writeFileSync(
        filePath,
        FederationRuntimePlugin.getTemplate(
          this.options.runtimePlugins!,
          this.bundlerRuntimePath,
          this.options.experiments,
        ),
      );
    }
  }

  getDependency() {
    if (this.federationRuntimeDependency)
      return this.federationRuntimeDependency;
    this.federationRuntimeDependency = new FederationRuntimeDependency(
      this.getFilePath(),
    );
    return this.federationRuntimeDependency;
  }

  prependEntry(compiler: Compiler) {
    if (!this.options?.virtualRuntimeEntry) {
      this.ensureFile();
    }

    compiler.hooks.thisCompilation.tap(
      'MyPlugin',
      (compilation: Compilation, { normalModuleFactory }) => {
        const federationRuntimeDependency = this.getDependency();
        const logger = compilation.getLogger('FederationRuntimePlugin');
        const hooks = FederationModulesPlugin.getCompilationHooks(compilation);
        compilation.dependencyFactories.set(
          FederationRuntimeDependency,
          normalModuleFactory,
        );
        compilation.dependencyTemplates.set(
          FederationRuntimeDependency,
          new ModuleDependency.Template(),
        );

        compilation.addInclude(
          compiler.context,
          federationRuntimeDependency,
          { name: undefined },
          (err, module) => {
            if (err) {
              logger.error('Error adding federation runtime module:', err);
              return;
            }
            hooks.getContainerEntryModules.call(federationRuntimeDependency);
          },
        );
      },
    );
  }

  injectRuntime(compiler: Compiler) {
    if (!this.options || !this.options.name) {
      return;
    }
    const name = this.options.name;
    const initOptionsWithoutShared = normalizeRuntimeInitOptionsWithOutShared(
      this.options,
    );
    const federationGlobal = getFederationGlobalScope(
      RuntimeGlobals || ({} as typeof RuntimeGlobals),
    );

    compiler.hooks.thisCompilation.tap(
      this.constructor.name,
      (compilation: Compilation, { normalModuleFactory }) => {
        const handler = (chunk: Chunk, runtimeRequirements: Set<string>) => {
          if (runtimeRequirements.has(federationGlobal)) return;
          runtimeRequirements.add(federationGlobal);
          runtimeRequirements.add(RuntimeGlobals.interceptModuleExecution);
          runtimeRequirements.add(RuntimeGlobals.moduleCache);
          runtimeRequirements.add(RuntimeGlobals.compatGetDefaultExport);

          compilation.addRuntimeModule(
            chunk,
            new FederationRuntimeModule(
              runtimeRequirements,
              name,
              initOptionsWithoutShared,
            ),
          );
        };

        compilation.hooks.additionalTreeRuntimeRequirements.tap(
          this.constructor.name,
          (chunk: Chunk, runtimeRequirements: Set<string>) => {
            if (!chunk.hasRuntime()) return;
            if (runtimeRequirements.has(RuntimeGlobals.initializeSharing))
              return;
            if (runtimeRequirements.has(RuntimeGlobals.currentRemoteGetScope))
              return;
            if (runtimeRequirements.has(RuntimeGlobals.shareScopeMap)) return;
            if (runtimeRequirements.has(federationGlobal)) return;
            handler(chunk, runtimeRequirements);
          },
        );

        // if federation runtime requirements exist
        // attach runtime module to the chunk
        compilation.hooks.runtimeRequirementInTree
          .for(RuntimeGlobals.initializeSharing)
          .tap(this.constructor.name, handler);
        compilation.hooks.runtimeRequirementInTree
          .for(RuntimeGlobals.currentRemoteGetScope)
          .tap(this.constructor.name, handler);
        compilation.hooks.runtimeRequirementInTree
          .for(RuntimeGlobals.shareScopeMap)
          .tap(this.constructor.name, handler);
        compilation.hooks.runtimeRequirementInTree
          .for(federationGlobal)
          .tap(this.constructor.name, handler);
      },
    );
  }

  setRuntimeAlias(compiler: Compiler) {
    const { experiments, implementation } = this.options || {};
    const isHoisted = experiments?.federationRuntime === 'hoisted';
    let runtimePath = isHoisted ? EmbeddedRuntimePath : RuntimePath;

    if (implementation) {
      runtimePath = require.resolve(
        `@module-federation/runtime${isHoisted ? '/embedded' : ''}`,
        { paths: [implementation] },
      );
    }

    if (isHoisted) {
      runtimePath = runtimePath.replace('.cjs', '.esm');
    }

    const alias = compiler.options.resolve.alias || {};
    alias['@module-federation/runtime$'] =
      alias['@module-federation/runtime$'] || runtimePath;
    alias['@module-federation/runtime-tools$'] =
      alias['@module-federation/runtime-tools$'] ||
      implementation ||
      RuntimeToolsPath;

    compiler.options.resolve.alias = alias;
  }

  apply(compiler: Compiler) {
    const useModuleFederationPlugin = compiler.options.plugins.find(
      (p: WebpackPluginInstance) => {
        if (typeof p !== 'object' || !p) {
          return false;
        }
        return p['name'] === 'ModuleFederationPlugin';
      },
    );

    if (useModuleFederationPlugin && !this.options) {
      // @ts-ignore
      this.options = useModuleFederationPlugin._options;
    }

    const useContainerPlugin = compiler.options.plugins.find(
      (p: WebpackPluginInstance) => {
        if (typeof p !== 'object' || !p) {
          return false;
        }

        return p['name'] === 'ContainerPlugin';
      },
    );

    if (useContainerPlugin && !this.options) {
      this.options = useContainerPlugin._options;
    }

    if (!useContainerPlugin && !useModuleFederationPlugin) {
      this.options = {
        remotes: {},
        ...this.options,
      };
    }
    if (this.options && !this.options?.name) {
      this.options.name =
        compiler.options.output.uniqueName || `container_${Date.now()}`;
    }

    if (this.options?.implementation) {
      this.bundlerRuntimePath = require.resolve(
        '@module-federation/webpack-bundler-runtime',
        {
          paths: [this.options.implementation],
        },
      );
    }
    if (this.options?.experiments?.federationRuntime === 'hoisted') {
      this.bundlerRuntimePath = this.bundlerRuntimePath.replace(
        '.cjs.js',
        '.esm.js',
      );

      new EmbedFederationRuntimePlugin(this.bundlerRuntimePath).apply(compiler);

      new HoistContainerReferences(
        this.options.name ? this.options.name + '_partial' : undefined,
        this.getFilePath(),
        this.bundlerRuntimePath,
        this.options.experiments,
      ).apply(compiler);

      new compiler.webpack.NormalModuleReplacementPlugin(
        /@module-federation\/runtime/,
        (resolveData) => {
          if (/webpack-bundler-runtime/.test(resolveData.contextInfo.issuer)) {
            resolveData.request = RuntimePath.replace('cjs', 'esm');

            if (resolveData.createData) {
              resolveData.createData.request = resolveData.request;
            }
          }
        },
      ).apply(compiler);
    }
    // dont run multiple times on every apply()
    if (!onceForCompler.has(compiler)) {
      this.prependEntry(compiler);
      this.injectRuntime(compiler);
      this.setRuntimeAlias(compiler);
      onceForCompler.add(compiler);
    }
  }
}

export default FederationRuntimePlugin;
