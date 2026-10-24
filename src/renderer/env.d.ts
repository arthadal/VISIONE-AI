import type { VisioneApi } from '../shared/contracts/index.ts';

declare global {
  interface Window {
    readonly visione: VisioneApi;
  }
}
