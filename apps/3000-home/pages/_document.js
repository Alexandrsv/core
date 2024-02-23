import React from 'react';
import Document, { Html, Head, Main, NextScript } from 'next/document';
// import HotReloader from 'next/dist/server/dev/hot-reloader-webpack'
import {
  revalidate,
  FlushedChunks,
  flushChunks,
  performReload,
} from '@module-federation/nextjs-mf/utils';

class MyDocument extends Document {
  static async getInitialProps(ctx) {
    // revalidate(undefined,true)
    // if (ctx.pathname) {
    //   if (!ctx.pathname.endsWith('_error')) {
    //     const gs = new Function('return globalThis')();
    //     for (const entry of gs.nextEntryCache) {
    //       delete __non_webpack_require__.cache[entry];
    //     }
    //     gs.nextEntryCache.clear();
    //   }
    // }

    const initialProps = await Document.getInitialProps(ctx);

    const chunks = await flushChunks();
    ctx?.res?.on('finish', () => {
      revalidate().then((shouldUpdate) => {
        if (shouldUpdate) {
          console.log('should HMR', shouldUpdate);
        }
      });
    });

    return {
      ...initialProps,
      chunks,
    };
  }

  render() {
    return (
      <Html>
        <Head>
          <FlushedChunks chunks={this.props.chunks} />
        </Head>
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

export default MyDocument;
