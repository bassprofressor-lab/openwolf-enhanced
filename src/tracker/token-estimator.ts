// Re-export only. The implementation lives in src/hooks/token-estimator.ts, which the hook
// build (rootDir: src/hooks) can reach and this one can too — keeping a single extension
// table and a single set of char/token ratios for hooks, scanner and tracker alike.
export {
  detectContentType,
  estimateTokens,
  estimateFileTokens,
  getTokenRatios,
  DEFAULT_RATIOS,
  type ContentType,
  type TokenRatios,
} from "../hooks/token-estimator.js";
