export async function hfSearch(q) {
    const res = await fetch(`https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&direction=-1&limit=20`);
    if (!res.ok)
        throw new Error(`huggingface search failed (${res.status})`);
    const data = (await res.json());
    return data.map((d) => ({ id: d.id, downloads: d.downloads ?? 0 }));
}
export async function hfFiles(repo) {
    const res = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`);
    if (!res.ok)
        throw new Error(`huggingface repo lookup failed (${res.status})`);
    const data = (await res.json());
    return (data.siblings ?? [])
        .filter((s) => s.rfilename.toLowerCase().endsWith(".gguf"))
        .map((s) => ({ name: s.rfilename, size: s.size ?? 0 }));
}
export function hfUrl(repo, file) {
    return `https://huggingface.co/${repo}/resolve/main/${file}`;
}
