const isTTY = Boolean(process.stdout.isTTY);
const useColor = isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const fancy = process.platform !== "win32" || Boolean(process.env.WT_SESSION);
function wrap(open, close) {
    return (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}
export const c = {
    bold: wrap("1", "22"),
    dim: wrap("2", "22"),
    red: wrap("31", "39"),
    green: wrap("32", "39"),
    yellow: wrap("33", "39"),
    blue: wrap("34", "39"),
    magenta: wrap("35", "39"),
    cyan: wrap("36", "39"),
    gray: wrap("90", "39"),
};
export const sym = fancy
    ? {
        ok: "\u2714",
        fail: "\u2718",
        warn: "\u26a0",
        info: "\u2139",
        dot: "\u2022",
        arrow: "\u2192",
        node: "\u25c6",
        hbar: "\u2500",
        tl: "\u256d",
        tr: "\u256e",
        bl: "\u2570",
        br: "\u256f",
        vbar: "\u2502",
        block: "\u2588",
        light: "\u2591",
        spin: ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"],
    }
    : {
        ok: "+",
        fail: "x",
        warn: "!",
        info: "i",
        dot: "*",
        arrow: "->",
        node: "#",
        hbar: "-",
        tl: "+",
        tr: "+",
        bl: "+",
        br: "+",
        vbar: "|",
        block: "#",
        light: ".",
        spin: ["|", "/", "-", "\\"],
    };
export function visLen(s) {
    return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function pad(s, w) {
    return s + " ".repeat(Math.max(0, w - visLen(s)));
}
export function line(s = "") {
    console.log(s);
}
export function banner(version, sub) {
    console.log();
    console.log(`  ${c.bold(c.cyan("weld"))} ${c.gray("v" + version)}` +
        (sub ? `  ${c.gray(sym.dot)} ${c.gray(sub)}` : ""));
    console.log();
}
export function rule(label) {
    const width = 46;
    if (!label) {
        console.log(c.gray("  " + sym.hbar.repeat(width)));
        return;
    }
    const rest = Math.max(0, width - visLen(label) - 1);
    console.log(`  ${c.gray(label)} ${c.gray(sym.hbar.repeat(rest))}`);
}
export function ok(msg) {
    console.log(`  ${c.green(sym.ok)} ${msg}`);
}
export function fail(msg) {
    console.log(`  ${c.red(sym.fail)} ${msg}`);
}
export function warn(msg) {
    console.log(`  ${c.yellow(sym.warn)} ${msg}`);
}
export function info(msg) {
    console.log(`  ${c.blue(sym.info)} ${msg}`);
}
export function step(msg) {
    console.log(`  ${c.cyan(sym.arrow)} ${msg}`);
}
export function bullet(msg) {
    console.log(`  ${c.gray(sym.dot)} ${msg}`);
}
export function kv(key, value, width = 14) {
    console.log(`  ${c.gray(pad(key, width))} ${value}`);
}
export function table(rows, head) {
    const all = head ? [head, ...rows] : rows;
    const widths = [];
    for (const r of all) {
        r.forEach((cell, i) => {
            widths[i] = Math.max(widths[i] ?? 0, visLen(cell));
        });
    }
    const render = (r) => "  " + r.map((cell, i) => pad(cell, widths[i] ?? 0)).join("  ").trimEnd();
    if (head)
        console.log(c.gray(render(head)));
    for (const r of rows)
        console.log(render(r));
}
export function bar(frac, width = 22) {
    const f = Math.max(0, Math.min(1, frac));
    const filled = Math.round(f * width);
    return (c.cyan(sym.block.repeat(filled)) +
        c.gray(sym.light.repeat(width - filled)) +
        " " +
        c.gray((f * 100).toFixed(0).padStart(3) + "%"));
}
export function fmtBytes(n) {
    if (n >= 1e9)
        return (n / 1e9).toFixed(1) + "GB";
    if (n >= 1e6)
        return (n / 1e6).toFixed(0) + "MB";
    if (n >= 1e3)
        return (n / 1e3).toFixed(0) + "KB";
    return n + "B";
}
export function fmtMB(mb) {
    return mb >= 1000 ? (mb / 1000).toFixed(1) + "GB" : Math.round(mb) + "MB";
}
export function box(lines, title) {
    const inner = Math.max(...lines.map(visLen), title ? visLen(title) + 2 : 0) + 2;
    const top = title
        ? `${sym.tl}${sym.hbar} ${title} ${sym.hbar.repeat(Math.max(0, inner - visLen(title) - 3))}${sym.tr}`
        : `${sym.tl}${sym.hbar.repeat(inner)}${sym.tr}`;
    console.log("  " + c.gray(top));
    for (const l of lines) {
        console.log(`  ${c.gray(sym.vbar)} ${pad(l, inner - 2)} ${c.gray(sym.vbar)}`);
    }
    console.log("  " + c.gray(`${sym.bl}${sym.hbar.repeat(inner)}${sym.br}`));
}
export class Spinner {
    i = 0;
    timer;
    text;
    constructor(text) {
        this.text = text;
        if (isTTY) {
            this.timer = setInterval(() => this.render(), 90);
            if (typeof this.timer.unref === "function")
                this.timer.unref();
            this.render();
        }
        else {
            console.log(`  ${sym.dot} ${text}`);
        }
    }
    render() {
        const frame = sym.spin[this.i++ % sym.spin.length];
        process.stdout.write(`\r  ${c.cyan(frame)} ${this.text}      `);
    }
    update(text) {
        this.text = text;
        if (!isTTY)
            return;
    }
    clearLine() {
        if (isTTY)
            process.stdout.write("\r" + " ".repeat(Math.min(120, visLen(this.text) + 14)) + "\r");
    }
    halt() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        this.clearLine();
    }
    succeed(text) {
        this.halt();
        ok(text ?? this.text);
    }
    failed(text) {
        this.halt();
        fail(text ?? this.text);
    }
    stop() {
        this.halt();
    }
}
export class Progress {
    label;
    last = 0;
    constructor(label) {
        this.label = label;
    }
    update(got, total) {
        const now = Date.now();
        if (now - this.last < 120 && !(total && got >= total))
            return;
        this.last = now;
        const frac = total ? got / total : 0;
        const text = `  ${c.cyan(sym.dot)} ${this.label} ${bar(frac)} ${c.gray(fmtBytes(got) + (total ? "/" + fmtBytes(total) : ""))}`;
        if (isTTY)
            process.stdout.write("\r" + text + "    ");
    }
    done(msg) {
        if (isTTY)
            process.stdout.write("\r" + " ".repeat(110) + "\r");
        ok(msg ?? this.label);
    }
}
export async function confirm(question) {
    if (process.env.WELD_AUTO_ACCEPT === "1") {
        console.log(`  ${c.green(sym.ok)} ${question} ${c.gray("(auto-accepted)")}`);
        return true;
    }
    if (!process.stdin.isTTY) {
        console.log(`  ${c.yellow(sym.warn)} ${question} ${c.gray("(no tty, declining)")}`);
        return false;
    }
    process.stdout.write(`  ${c.cyan("?")} ${question} ${c.gray("[y/N]")} `);
    return new Promise((resolve) => {
        const onData = (buf) => {
            const answer = buf.toString().trim().toLowerCase();
            process.stdin.pause();
            process.stdin.off("data", onData);
            console.log();
            resolve(answer === "y" || answer === "yes");
        };
        process.stdin.resume();
        process.stdin.once("data", onData);
    });
}
export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
