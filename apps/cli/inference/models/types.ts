/**
 * Minimum shape the orchestrator reads off a `/v1/models` entry before
 * handing it to a backend-specific normalizer. Each backend module declares
 * its own extended interface internally and casts as needed.
 */
export interface RawModelEntry {
  id: string;
}
