import type { ModelCapability, ModelPurpose, WorkerModel } from "@shoal/protocol";
import type { RawModelEntry } from "./types";

/**
 * LM Studio's `/v1/models` returns extended fields beyond the OpenAI spec:
 * `type` (llm / vlm / embeddings), `arch`, `state`, `quantization`,
 * `max_context_length`. We rely on `type` for purpose and treat `vlm` as a
 * chat model with the `vision` capability.
 *
 * Reference: https://lmstudio.ai/docs/developer/rest/endpoints
 */

interface LMStudioEntry extends RawModelEntry {
  type?: string;
  arch?: string;
  state?: string;
  max_context_length?: number;
}

/** True when the response carries LM Studio's enriched fields. We require
 *  *two* of (type, arch, state) so a backend that happens to attach a single
 *  `type` field doesn't get mistaken for LM Studio. */
export function isLMStudioResponse(data: ReadonlyArray<RawModelEntry>): boolean {
  return data.some((m) => {
    let hits = 0;
    if (typeof (m as LMStudioEntry).type === "string") hits++;
    if (typeof (m as LMStudioEntry).arch === "string") hits++;
    if (typeof (m as LMStudioEntry).state === "string") hits++;
    return hits >= 2;
  });
}

export function normalizeLMStudioModels(
  data: ReadonlyArray<RawModelEntry>,
): WorkerModel[] {
  return data.map((m) => normalizeOne(m as LMStudioEntry));
}

function normalizeOne(m: LMStudioEntry): WorkerModel {
  let purpose: ModelPurpose | undefined;
  const capabilities: ModelCapability[] = [];

  switch (m.type) {
    case "llm":
      purpose = "chat";
      break;
    case "vlm":
      purpose = "chat";
      capabilities.push("vision");
      break;
    case "embeddings":
      purpose = "embedding";
      break;
    // Other types (or absent type) leave purpose undefined; the server's
    // permit-unknown contract keeps the model routable.
  }

  const out: WorkerModel = { id: m.id };
  if (purpose !== undefined) out.purpose = purpose;
  if (capabilities.length > 0) out.capabilities = capabilities;
  return out;
}
