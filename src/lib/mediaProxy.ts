import { invoke, isTauri } from "@tauri-apps/api/core";

export const nativeHeaderProxyAvailable = isTauri();

/** The proxy streams one source byte for byte, adding the addon's request headers in Rust. */
export function startMediaProxy(url: string, headers: Record<string, string>): Promise<string> {
  return invoke<string>("media_proxy_start", { url, headers });
}

export function stopMediaProxy(url: string): void {
  void invoke("media_proxy_stop", { url }).catch(() => {});
}
