// @bamboo/shared: what the engine and the Mac side must compute identically (DESIGN §1):
// Zod contracts, text normalization, turn keys, PDF-text segmentation and Mac-side config.
// TypeScript source, no build step. Contracts and turns.ts arrive in M3.

export const SHARED_PACKAGE = "@bamboo/shared";

export * from "./text";
