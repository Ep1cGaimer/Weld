export class JsonLines {
    writeRaw;
    onMsg;
    buf = "";
    constructor(writeRaw, onMsg) {
        this.writeRaw = writeRaw;
        this.onMsg = onMsg;
    }
    feed(chunk) {
        this.buf += chunk;
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
            const raw = this.buf.slice(0, i);
            this.buf = this.buf.slice(i + 1);
            if (!raw)
                continue;
            let parsed = null;
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                parsed = null;
            }
            if (parsed)
                this.onMsg(parsed);
        }
    }
    send(m) {
        this.writeRaw(JSON.stringify(m) + "\n");
    }
}
