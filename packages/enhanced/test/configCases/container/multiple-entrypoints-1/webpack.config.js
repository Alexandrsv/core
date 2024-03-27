const { ModuleFederationPlugin } = require('../../../../dist/src');

const common = {
  name: 'container',
  exposes: {
    './ComponentA': {
      import: './ComponentA',
    },
  },
  shared: {
    react: {
      version: false,
      requiredVersion: false,
    },
  },
};

module.exports = [
  {
    entry: {
      main: './index.js',
      other: './other.js',
    },
    output: {
      filename: '[name].js',
      uniqueName: '0-container-full',
    },
    optimization: {
      runtimeChunk: false,
    },
    plugins: [
      new ModuleFederationPlugin({
        library: { type: 'commonjs-module' },
        filename: 'container.js',
        remotes: {
          containerA: {
            external: './container.js',
          },
        },
        ...common,
      }),
    ],
  },
  {
    experiments: {
      outputModule: true,
    },
    output: {
      filename: 'module/[name].mjs',
      uniqueName: '0-container-full-mjs',
    },
    plugins: [
      new ModuleFederationPlugin({
        library: { type: 'module' },
        filename: 'module/container.mjs',
        remotes: {
          containerA: {
            external: './container.mjs',
          },
        },
        ...common,
      }),
    ],
    target: 'node14',
  },
];
