import type { YushuApi } from "./api";

declare global {
  interface Window {
    yushu: YushuApi;
  }
}

export {};