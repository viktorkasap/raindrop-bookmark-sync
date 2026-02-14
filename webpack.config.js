const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = (env) => {
  const browser = env.browser || 'firefox';

  return {
    entry: {
      background: './src/background/index.ts',
      popup: './src/popup/popup.ts',
      options: './src/options/options.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist', browser),
      filename: '[name].js',
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: [MiniCssExtractPlugin.loader, 'css-loader'],
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    plugins: [
      new webpack.ProvidePlugin({
        browser: 'webextension-polyfill',
      }),
      new MiniCssExtractPlugin({
        filename: '[name]/[name].css',
      }),
      new HtmlWebpackPlugin({
        template: './src/popup/popup.html',
        filename: 'popup/popup.html',
        chunks: ['popup'],
        inject: false,
      }),
      new HtmlWebpackPlugin({
        template: './src/options/options.html',
        filename: 'options/options.html',
        chunks: ['options'],
        inject: false,
      }),
      new CopyPlugin({
        patterns: [
          { from: `manifests/${browser}.json`, to: 'manifest.json' },
          { from: 'icons', to: 'icons' },
          { from: 'src/popup/popup.css', to: 'popup/popup.css' },
          { from: 'src/options/options.css', to: 'options/options.css' },
        ],
      }),
    ],
    devtool: 'source-map',
    optimization: {
      minimize: false,
    },
  };
};
