export { applyTextPostprocess, type ApplyTextPostprocessInput } from './apply';
export { serializeScopedCss } from './css-model';
export { resolveTrustedTree, type ResolvedNode } from './resolve-tree';
export {
  prepareSlotTransport,
  resolveTransportedTextNodes,
  type SlotTransportEntry,
  type SlotTransportResult,
  type TransportDecision,
} from './slot-transport';
export { validateCompiledArtifact, type ArtifactValidation } from './validate-artifact';
