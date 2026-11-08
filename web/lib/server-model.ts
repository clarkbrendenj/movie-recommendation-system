import { env } from "cloudflare:workers";
import { createModel } from "./recommender.mjs";

type Metadata = Parameters<typeof createModel>[0];
type SparseGroup = Parameters<typeof createModel>[1][number];
type Model = ReturnType<typeof createModel>;
type Descriptor = Metadata["groups"][number]["data"];

let metadataPromise: Promise<Metadata> | undefined;
let modelPromise: Promise<Model> | undefined;

async function asset(file: string): Promise<Response> {
  // File paths come exclusively from the versioned model manifest, never from
  // request parameters. Keep inference entirely within this Site's assets.
  if (!/^[a-z0-9._-]+$/i.test(file)) throw new Error("Invalid model asset path.");
  const assets = (env as unknown as { ASSETS?: { fetch: typeof fetch } }).ASSETS;
  if (!assets) throw new Error("The model assets binding is unavailable.");
  const origin = import.meta.env.DEV ? "http://127.0.0.1:5173" : "https://model-assets.local";
  const response = await assets.fetch(new Request(`${origin}/model/${file}`));
  if (!response.ok) throw new Error(`Model asset unavailable: ${file} (HTTP ${response.status}).`);
  return response;
}

export function getModelMetadata(): Promise<Metadata> {
  if (!metadataPromise) {
    metadataPromise = (async () => {
      const response = await asset("metadata.json");
      const metadata = await response.json() as Metadata;
      if (metadata.version !== 1 || metadata.itemCount !== metadata.movies?.length || !Array.isArray(metadata.groups)) {
        throw new Error("The deployed model metadata is incomplete.");
      }
      return metadata;
    })().catch((error) => { metadataPromise = undefined; throw error; });
  }
  return metadataPromise;
}

async function loadArray(descriptor: Descriptor) {
  const buffer = await (await asset(descriptor.file)).arrayBuffer();
  if (descriptor.bytes !== undefined && buffer.byteLength !== descriptor.bytes) throw new Error("Truncated model asset.");
  if (descriptor.dtype === "uint32") return new Uint32Array(buffer);
  if (descriptor.dtype === "uint16") return new Uint16Array(buffer);
  if (descriptor.dtype === "float32") return new Float32Array(buffer);
  throw new Error("Unsupported model array encoding.");
}

export function getModel(): Promise<Model> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const metadata = await getModelMetadata();
      const groups: SparseGroup[] = [];
      // Sequential fetches bound the temporary Response buffers in a Worker.
      for (const descriptor of metadata.groups) {
        const indptr = await loadArray(descriptor.indptr) as Uint32Array;
        const indices = await loadArray(descriptor.indices) as Uint16Array | Uint32Array;
        const data = await loadArray(descriptor.data) as Float32Array;
        groups.push({ name: descriptor.name, rows: descriptor.rows, columns: descriptor.columns, indptr, indices, data });
      }
      return createModel(metadata, groups);
    })().catch((error) => { modelPromise = undefined; throw error; });
  }
  return modelPromise;
}
