import { openSync, readSync, closeSync, fstatSync } from "node:fs";

export interface GgufInfo {
  meta: Record<string, string | number | boolean>;
  weightsBytes: number;
  fileBytes: number;
  tensorCount: number;
}

const WINDOW = 1 << 20;

class Reader {
  pos = 0;
  private buf: Buffer = Buffer.alloc(0);
  private bufStart = 0;

  constructor(
    private fd: number,
    private size: number
  ) {}

  private take(n: number): Buffer {
    if (this.pos + n > this.size) throw new Error("gguf: unexpected end of file");
    if (n > WINDOW) {
      const direct = Buffer.alloc(n);
      readSync(this.fd, direct, 0, n, this.pos);
      this.pos += n;
      this.buf = Buffer.alloc(0);
      this.bufStart = 0;
      return direct;
    }
    const inWindow =
      this.pos >= this.bufStart && this.pos + n <= this.bufStart + this.buf.length;
    if (!inWindow) {
      const len = Math.min(WINDOW, this.size - this.pos);
      const next = Buffer.alloc(len);
      readSync(this.fd, next, 0, len, this.pos);
      this.buf = next;
      this.bufStart = this.pos;
    }
    const off = this.pos - this.bufStart;
    this.pos += n;
    return this.buf.subarray(off, off + n);
  }

  u8(): number {
    return this.take(1)[0];
  }

  magic(): string {
    return this.take(4).toString("utf8");
  }

  int(bytes: number, signed: boolean): number {
    const b = this.take(bytes);
    if (bytes <= 6) return signed ? b.readIntLE(0, bytes) : b.readUIntLE(0, bytes);
    return Number(signed ? b.readBigInt64LE(0) : b.readBigUInt64LE(0));
  }

  u32(): number {
    return this.int(4, false);
  }

  u64(): number {
    return this.int(8, false);
  }

  str(): string {
    const len = this.u64();
    if (len > 64 * 1024 * 1024) throw new Error("gguf: implausible string length");
    return this.take(len).toString("utf8");
  }

  f32(): number {
    return this.take(4).readFloatLE(0);
  }

  f64(): number {
    return this.take(8).readDoubleLE(0);
  }
}

type Scalar = string | number | boolean;

function readValue(r: Reader, t: number): Scalar | Scalar[] {
  switch (t) {
    case 0:
      return r.u8();
    case 1:
      return r.int(1, true);
    case 2:
      return r.int(2, false);
    case 3:
      return r.int(2, true);
    case 4:
      return r.u32();
    case 5:
      return r.int(4, true);
    case 6:
      return r.f32();
    case 7:
      return r.u8() === 1;
    case 8:
      return r.str();
    case 9: {
      const elemType = r.u32();
      const count = r.u64();
      const out: Scalar[] = [];
      for (let i = 0; i < count; i++) {
        const v = readValue(r, elemType) as Scalar;
        if (i < 16) out.push(v);
      }
      return out;
    }
    case 10:
      return r.u64();
    case 11:
      return r.int(8, true);
    case 12:
      return r.f64();
    default:
      throw new Error(`gguf: unknown metadata type ${t}`);
  }
}

export function parseGgufHeader(file: string): GgufInfo {
  const fd = openSync(file, "r");
  try {
    const fileBytes = fstatSync(fd).size;
    const r = new Reader(fd, fileBytes);
    const magic = r.magic();
    if (magic !== "GGUF") throw new Error(`${file} is not a GGUF file`);
    const version = r.u32();
    if (version < 2 || version > 3) throw new Error(`unsupported gguf version ${version}`);
    const tensorCount = r.u64();
    const kvCount = r.u64();
    const meta: Record<string, Scalar> = {};
    for (let i = 0; i < kvCount; i++) {
      const key = r.str();
      const type = r.u32();
      const value = readValue(r, type);
      if (!Array.isArray(value)) meta[key] = value;
    }
    for (let i = 0; i < tensorCount; i++) {
      r.str();
      const dims = r.u32();
      for (let d = 0; d < dims; d++) r.u64();
      r.u32();
      r.u64();
    }
    const alignment = Number(meta["general.alignment"] ?? 32) || 32;
    const dataStart = Math.ceil(r.pos / alignment) * alignment;
    return { meta, tensorCount, weightsBytes: fileBytes - dataStart, fileBytes };
  } finally {
    closeSync(fd);
  }
}
