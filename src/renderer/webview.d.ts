// Il tag <webview> di Electron per il browser di VISIONE (12/10/2026): solo gli attributi che si usano.
import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
      };
    }
  }
}
