import { invoke } from '@tauri-apps/api/core';
import type { ModelArchInfo } from './ollama';

export interface SystemResources {
  totalRamBytes: number;
  availableRamBytes: number;
  gpuName: string | null;
  totalVramBytes: number | null;
  availableVramBytes: number | null;
}

interface RawSystemResources {
  total_ram_bytes: number;
  available_ram_bytes: number;
  gpu_name: string | null;
  total_vram_bytes: number | null;
  available_vram_bytes: number | null;
}

export async function getSystemResources(): Promise<SystemResources> {
  const raw = await invoke<RawSystemResources>('get_system_resources');
  return {
    totalRamBytes: raw.total_ram_bytes,
    availableRamBytes: raw.available_ram_bytes,
    gpuName: raw.gpu_name,
    totalVramBytes: raw.total_vram_bytes,
    availableVramBytes: raw.available_vram_bytes,
  };
}

export function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// Fallback when a real KV-cache estimate isn't possible — a flat +15% of
// model size, clearly a cruder floor than the real per-context calculation
// below. Confirmed against a live case where this mattered (2026-08-19,
// qwen3.5:9b at a 104k-token num_ctx): actual VRAM usage was ~12GB;
// treating GQA's real (small) KV head count as unknown-but-real-headCount
// instead of just refusing to compute produced a confidently-wrong ~57GB.
const FALLBACK_OVERHEAD_MULTIPLIER = 1.15;

// Standard KV-cache sizing: two tensors (K and V) per layer, each
// `numCtx * headCountKV * headDim` elements, at 2 bytes/element (f16 —
// Ollama's default KV cache dtype unless quantized KV cache is explicitly
// configured, which this doesn't try to detect). This is *why* the
// forecast actually moves when the context-length slider moves — the
// model's own weight size (modelBytes) is fixed regardless of numCtx, this
// term is the part that scales with it.
//
// headCountKV absent is NOT the same situation as the other fields being
// absent, and used to be treated as one: this used to fall back to
// headCount (i.e. assume no GQA) whenever headCountKV was missing, which
// is a real, common case for Ollama's model_info (confirmed live:
// qwen3.5:9b reports every other field but head_count_kv: null) — and
// silently produced a wildly, confidently wrong number (~57GB vs. ~12GB
// actually observed), because modern models overwhelmingly *do* use GQA
// with far fewer KV heads than query heads, so "assume none" is usually
// wrong in the worst direction: an inflated number that looks precise.
// Refusing to compute at all here (falls through to the flatter, honestly
// labeled estimate below) is strictly better than a specific wrong answer.
export function estimateKvCacheBytes(numCtx: number, arch: ModelArchInfo): number | null {
  const { numLayers, embeddingLength, headCount, headCountKV } = arch;
  if (!numLayers || !embeddingLength || !headCount || !headCountKV) return null;
  const headDim = embeddingLength / headCount;
  const bytesPerElement = 2;
  return numCtx * numLayers * 2 * headCountKV * headDim * bytesPerElement;
}

export type FitVerdict = 'vram' | 'vram-tight' | 'ram-spill' | 'too-large' | 'vram-unknown';

export interface ResourceForecast {
  verdict: FitVerdict;
  estimatedNeededBytes: number;
  summary: string;
}

export function forecastFit(
  modelBytes: number,
  numCtx: number,
  arch: ModelArchInfo,
  resources: SystemResources
): ResourceForecast {
  const kvCacheBytes = estimateKvCacheBytes(numCtx, arch);
  const overheadBytes = kvCacheBytes ?? modelBytes * (FALLBACK_OVERHEAD_MULTIPLIER - 1);
  const estimatedNeededBytes = modelBytes + overheadBytes;
  const need = formatGiB(estimatedNeededBytes);
  const breakdown = kvCacheBytes
    ? `${formatGiB(modelBytes)} model + ~${formatGiB(kvCacheBytes)} KV cache @ ${numCtx.toLocaleString()} ctx`
    : `${formatGiB(
        modelBytes
      )} model — can't estimate KV cache (this model doesn't report its GQA key/value head count), so this is a floor, not the real number; actual usage at a large context length can be meaningfully higher`;

  if (resources.totalVramBytes == null || resources.availableVramBytes == null) {
    return {
      verdict: 'vram-unknown',
      estimatedNeededBytes,
      summary: `~${need} needed (${breakdown}). No NVIDIA GPU detected (nvidia-smi unavailable) — can't forecast VRAM fit; AMD/Intel VRAM isn't read yet. ${formatGiB(
        resources.availableRamBytes
      )} of ${formatGiB(resources.totalRamBytes)} RAM free.`,
    };
  }

  const vramAvail = formatGiB(resources.availableVramBytes);
  const vramTotal = formatGiB(resources.totalVramBytes);
  const gpu = resources.gpuName ?? 'GPU';

  if (estimatedNeededBytes <= resources.availableVramBytes) {
    return {
      verdict: 'vram',
      estimatedNeededBytes,
      summary: `~${need} needed (${breakdown}) — fits in ${gpu}'s free VRAM (${vramAvail} of ${vramTotal} free).`,
    };
  }
  if (estimatedNeededBytes <= resources.totalVramBytes) {
    return {
      verdict: 'vram-tight',
      estimatedNeededBytes,
      summary: `~${need} needed (${breakdown}) — fits ${gpu}'s total VRAM (${vramTotal}) but only ${vramAvail} is free right now; close other GPU workloads first or it'll spill to RAM.`,
    };
  }
  if (estimatedNeededBytes <= resources.availableRamBytes) {
    return {
      verdict: 'ram-spill',
      estimatedNeededBytes,
      summary: `~${need} needed (${breakdown}) — larger than ${gpu}'s ${vramTotal} VRAM, so it'll partially or fully run on CPU/RAM instead (slower). ${formatGiB(
        resources.availableRamBytes
      )} RAM free.`,
    };
  }
  return {
    verdict: 'too-large',
    estimatedNeededBytes,
    summary: `~${need} needed (${breakdown}) — larger than both ${gpu}'s VRAM (${vramTotal}) and free RAM (${formatGiB(
      resources.availableRamBytes
    )}). It may fail to load or swap heavily.`,
  };
}
