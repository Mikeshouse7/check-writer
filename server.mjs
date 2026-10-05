// Check Writer — serves the app and keeps one shared copy of your accounts and
// checks, so the phone and the PC see the same register.
// Online (Railway): data lives on the Railway volume, APP_PASSCODE is required.
// On this PC:  node server.mjs  →  http://localhost:5185
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ONLINE = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_VOLUME_MOUNT_PATH);
const PORT = Number(process.env.PORT || 5185);
const DATA = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(DIR, "data");
const STATE_FILE = path.join(DATA, "state.json");
const BACKUPS = path.join(DATA, "backups");
const KEEP_BACKUPS = 60;

/* ---------------- settings: own .env → Railway Variables ---------------- */
function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch (e) {}
  return out;
}
const OWN_ENV = readEnvFile(path.join(DIR, ".env"));
const env = (k) => process.env[k] || OWN_ENV[k] || "";
const PASSCODE = env("APP_PASSCODE");

/* ---------------- storage ---------------- */
fs.mkdirSync(BACKUPS, { recursive: true });
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return { rev: 0, data: null }; }
}
let current = loadState();
let lastBackup = 0;
function writeState(next) {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, STATE_FILE);
  // A dated copy at most every 10 minutes, so a bad save can be undone.
  if (Date.now() - lastBackup > 10 * 60000) {
    lastBackup = Date.now();
    fs.writeFileSync(path.join(BACKUPS, "state-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json"), JSON.stringify(next));
    const old = fs.readdirSync(BACKUPS).filter((f) => f.startsWith("state-")).sort();
    old.slice(0, Math.max(0, old.length - KEEP_BACKUPS)).forEach((f) => fs.rmSync(path.join(BACKUPS, f), { force: true }));
  }
}

/* ---------------- the lock (required online) ---------------- */
const FAILS = new Map();   // ip -> { n, first }
function codeOk(supplied) {
  const a = Buffer.from(String(supplied || "")), b = Buffer.from(PASSCODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function clientIp(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }

/* ---------------- tiny HTTP server ---------------- */
const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};
function send(res, status, body, type) {
  res.writeHead(status, { ...SECURITY, "Content-Type": type || "application/json; charset=utf-8" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, max = 25e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > max) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(n ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  try {
    if (u.pathname === "/" || u.pathname === "/index.html") {
      return send(res, 200, fs.readFileSync(path.join(DIR, "index.html")), "text/html; charset=utf-8");
    }
    if (u.pathname === "/api/ping") return send(res, 200, { app: "check-writer", locked: !!PASSCODE });
    if (u.pathname.startsWith("/api/")) {
      if (ONLINE && !PASSCODE) return send(res, 503, { error: "Check Writer is locked shut: set APP_PASSCODE in Railway → Variables first." });
      if (PASSCODE) {
        const ip = clientIp(req);
        const f = FAILS.get(ip);
        if (f && f.n >= 10 && Date.now() - f.first < 15 * 60000) return send(res, 429, { error: "Too many wrong codes. Wait 15 minutes and try again." });
        if (!codeOk(req.headers["x-app-code"])) {
          const g = f && Date.now() - f.first < 15 * 60000 ? f : { n: 0, first: Date.now() };
          g.n++; FAILS.set(ip, g);
          return send(res, 401, { error: "Wrong access code." });
        }
        FAILS.delete(ip);
      }
    }
    if (u.pathname === "/api/state" && req.method === "GET") {
      return send(res, 200, { rev: current.rev, data: current.data, savedAt: current.savedAt || null });
    }
    if (u.pathname === "/api/state" && req.method === "PUT") {
      const body = await readBody(req);
      const d = body.data;
      if (!d || !Array.isArray(d.accounts) || !Array.isArray(d.register)) return send(res, 400, { error: "That isn't Check Writer data." });
      // Another device saved first: send its copy back so this one can merge.
      if (Number(body.baseRev) !== current.rev) return send(res, 409, { rev: current.rev, data: current.data });
      const next = { rev: current.rev + 1, savedAt: new Date().toISOString(), data: d };
      writeState(next);
      current = next;
      return send(res, 200, { rev: current.rev, savedAt: current.savedAt });
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    send(res, e.message === "too large" ? 413 : 500, { error: e.message === "too large" ? "Too much data (shrink the logo or signature images)." : "Server error" });
  }
});

server.listen(PORT, ONLINE ? "0.0.0.0" : "127.0.0.1", () => {
  console.log("Check Writer running" + (ONLINE ? " online" : "") + ", data in " + DATA);
  if (!ONLINE) console.log("Open:  http://localhost:" + PORT + "/");
  if (!PASSCODE) console.log(ONLINE ? "APP_PASSCODE is not set: every /api call is refused." : "No APP_PASSCODE set: anyone on this PC can open it.");
});
