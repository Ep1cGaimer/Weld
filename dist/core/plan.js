export function poolOf(t) {
    const vram = t.gpus.reduce((a, g) => a + g.vramFreeMB, 0);
    if (vram > 0)
        return vram + t.ramFreeMB * 0.2;
    return t.ramFreeMB * 0.7;
}
export function kvBytes(meta, ctx) {
    const arch = String(meta["general.architecture"] || "");
    if (!arch)
        return 0;
    const layers = Number(meta[`${arch}.block_count`] || 0);
    const embd = Number(meta[`${arch}.embedding_length`] || 0);
    if (!layers || !embd)
        return 0;
    const heads = Number(meta[`${arch}.attention.head_count`] || 32);
    const kvHeads = Number(meta[`${arch}.attention.head_count_kv`] || heads);
    const keyLen = Number(meta[`${arch}.attention.key_length`] || embd / heads);
    const nEmbdKv = kvHeads * keyLen;
    return 2 * layers * ctx * nEmbdKv * 2;
}
export function fit(info, ctx, nodes) {
    const poolMB = nodes.reduce((a, n) => a + poolOf(n), 0);
    const weightsMB = info.weightsBytes / 1e6;
    const rawKv = kvBytes(info.meta, ctx);
    const kvMB = (rawKv || info.weightsBytes * 0.15) / 1e6;
    const needMB = weightsMB + kvMB * 1.15;
    const headroomMB = poolMB - needMB;
    const advice = headroomMB >= 0
        ? `fits with ${(headroomMB / 1000).toFixed(1)}GB headroom`
        : `short by ${(-headroomMB / 1000).toFixed(1)}GB — add a node, lower --ctx, or pick a smaller quant`;
    return { fits: headroomMB >= 0, poolMB, weightsMB, kvMB, needMB, headroomMB, advice };
}
