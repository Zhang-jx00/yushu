/* SPDX-License-Identifier: Apache-2.0 */
import type { YushuApi } from "./api";

declare global {
  interface Window {
    yushu: YushuApi;
  }
}

export {};