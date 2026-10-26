// Just enough of the obsidian module for VaultStore to run under Node.
export class TFile {}
export class TFolder {}
export const normalizePath = (p: string) => p.replace(/\/+/g, "/");
export class App {}
// Tests install a fake network on globalThis.__requestUrl.
export const requestUrl = (req: any) => (globalThis as any).__requestUrl(req);
export const arrayBufferToBase64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
