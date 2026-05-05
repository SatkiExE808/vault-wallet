const path    = require('path');
const webpack = require('webpack');

module.exports = {
  mode: 'production',
  entry: './src/monero-entry.js',
  output: {
    path:     path.resolve(__dirname, 'lib'),
    filename: 'monero-browser.js',
  },
  target: 'web',
  module: {
    rules: [{
      test: /\.js$/,
      exclude: /node_modules/,
      use: {
        loader: 'babel-loader',
        options: {
          presets: ['@babel/preset-env'],
          cacheDirectory: false,
        },
      },
    }],
  },
  plugins: [
    new webpack.ProvidePlugin({
      process: 'process/browser',
      Buffer:  ['buffer', 'Buffer'],
    }),
  ],
  externals: ['worker_threads', 'ws', 'perf_hooks', 'child_process'],
  resolve: {
    alias: { fs: 'html5-fs' },
    fallback: {
      assert:      require.resolve('assert'),
      crypto:      require.resolve('crypto-browserify'),
      http:        require.resolve('stream-http'),
      https:       require.resolve('https-browserify'),
      os:          require.resolve('os-browserify/browser'),
      path:        require.resolve('path-browserify'),
      querystring: require.resolve('querystring-es3'),
      stream:      require.resolve('stream-browserify'),
      url:         require.resolve('url'),
      util:        require.resolve('util'),
      zlib:        require.resolve('browserify-zlib'),
      net:         false,
      tls:         false,
    },
  },
};
