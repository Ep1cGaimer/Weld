export interface HfModel {
  id: string;
  downloads: number;
}

export interface HfFile {
  name: string;
  size: number;
}

export async function hfSearch(q: string): Promise<HfModel[]> {
  const res = await fetch(
    `https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&direction=-1&limit=20`
  );
  if (!res.ok) throw new Error(`huggingface search failed (${res.status})`);
  const data = (await res.json()) as { id: string; downloads?: number }[];
  return data.map((d) => ({ id: d.id, downloads: d.downloads ?? 0 }));
}

export async function hfFiles(repo: string): Promise<HfFile[]> {
  const res = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`);
  if (!res.ok) throw new Error(`huggingface repo lookup failed (${res.status})`);
  const data = (await res.json()) as { siblings?: { rfilename: string; size?: number }[] };
  return (data.siblings ?? [])
    .filter((s) => s.rfilename.toLowerCase().endsWith(".gguf"))
    .map((s) => ({ name: s.rfilename, size: s.size ?? 0 }));
}

export function hfUrl(repo: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}
