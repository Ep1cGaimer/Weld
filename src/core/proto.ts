export interface GpuInfo {
  name: string;
  vramTotalMB: number;
  vramFreeMB: number;
}

export interface Telemetry {
  nodeId: string;
  name: string;
  gpus: GpuInfo[];
  ramFreeMB: number;
  ramTotalMB: number;
  build: string;
  rpcUp: boolean;
  platform: string;
}

export type Msg =
  | { t: "hello"; nodeId: string; name: string; build: string }
  | { t: "helloAck" }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number }
  | ({ t: "telemetry" } & Telemetry)
  | { t: "join"; sessionId: string; build: string }
  | { t: "joined"; ok: true; rpcPort: number }
  | { t: "joined"; ok: false; error: string }
  | { t: "leave"; sessionId?: string }
  | {
      t: "pairRequest";
      code: string;
      name: string;
      certPem: string;
      controlPort: number;
      relayPort: number;
    }
  | { t: "pairAccept"; name: string; certPem: string; controlPort: number; relayPort: number }
  | { t: "pairDeny" };

export class JsonLines {
  private buf = "";

  constructor(
    private writeRaw: (s: string) => boolean,
    private onMsg: (m: Msg) => void
  ) {}

  feed(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!raw) continue;
      let parsed: Msg | null = null;
      try {
        parsed = JSON.parse(raw) as Msg;
      } catch {
        parsed = null;
      }
      if (parsed) this.onMsg(parsed);
    }
  }

  send(m: Msg): void {
    this.writeRaw(JSON.stringify(m) + "\n");
  }
}
