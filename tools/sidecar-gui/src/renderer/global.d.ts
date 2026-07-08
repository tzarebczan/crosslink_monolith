import type { SidecarApi } from "../preload";

declare global {
  interface Window {
    sidecar: SidecarApi;
  }
}
