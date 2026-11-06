// @bamboo/shared: what the engine and the Mac side must compute identically (DESIGN §1):
// Zod contracts, text normalization, turn keys, PDF-text segmentation and Mac-side config.
// TypeScript source, no build step.

export const SHARED_PACKAGE = "@bamboo/shared";

export * from "./text";
export * from "./config";
export * from "./turns";
export * from "./segment";
export * from "./contracts/index";
