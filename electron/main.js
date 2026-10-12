/**
 * AVIA Desktop — main process.
 *
 * SEM segredo embutido: na primeira abertura, uma tela de configuração pede
 * o Supabase e a chave de IA do CLIENTE e grava em userData/avia.env
 * (fora do pacote, por máquina). O instalador distribuído contém ZERO chaves.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const PORT = Number(process.env.AVIA_PORT || 3000);
const HOST = "127.0.0.1";

function baseDir() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

function userEnvFile() {
  return path.join(app.getPath("userData"), "avia.env");
}

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#") || !clean.includes("=")) continue;
    const idx = clean.indexOf("=");
    out[clean.slice(0, idx).trim()] = clean.slice(idx + 1).trim();
  }
  return out;
}

function configCompleta(env) {
  return Boolean(
    env.NEXT_PUBLIC_SUPABASE_URL &&
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      env.SUPABASE_SERVICE_ROLE_KEY &&
      env.SUPABASE_DB_URL &&
      env.GROQ_API_KEY,
  );
}

function loadEnv() {
  // 1. config do usuário (primeira abertura); 2. modelo do pacote; 3. ambiente.
  const merged = { ...readEnvFile(path.join(baseDir(), "avia.env")), ...readEnvFile(userEnvFile()) };
  for (const [k, v] of Object.entries(merged)) {
    if (process.env[k] === undefined && v) process.env[k] = v;
  }
  return merged;
}

function nodeBin() {
  const dir = path.join(baseDir(), "node-runtime");
  if (process.platform === "win32") return path.join(dir, "win", "node.exe");
  if (process.platform === "darwin") return path.join(dir, "mac", "node");
  return path.join(dir, "linux", "node");
}

function waitForServer(url, timeoutMs = 120000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
        if (res.statusCode && res.statusCode < 500) return resolve(true);
        setTimeout(tick, 1000);
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
        setTimeout(tick, 1000);
      });
    };
    tick();
  });
}

const children = [];

function startBackend() {
  const serverDir = path.join(baseDir(), "server");
  const secrets = {
    INTERNAL_SECRET: crypto.randomBytes(32).toString("hex"),
    IMPERSONATE_COOKIE_SECRET: crypto.randomBytes(32).toString("base64"),
    CPF_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    WAHA_BYO_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    AI_CRED_AES_KEY: crypto.randomBytes(32).toString("base64"),
  };
  for (const [k, v] of Object.entries(secrets)) {
    if (!process.env[k]) process.env[k] = v;
  }
  const env = {
    ...process.env,
    PORT: String(PORT),
    HOSTNAME: HOST,
    NEXT_PUBLIC_APP_URL: `http://${HOST}:${PORT}`,
    NEXT_PUBLIC_ADMIN_URL: `http://${HOST}:${PORT}`,
    APP_NAME: process.env.APP_NAME || "AVIA",
    APP_LOGO_URL: process.env.APP_LOGO_URL || "/avia-logo.png",
    APP_ACCENT_HEX: process.env.APP_ACCENT_HEX || "#A98A50",
  };
  const server = spawn(nodeBin(), [path.join(serverDir, "server.js")], {
    cwd: serverDir,
    env,
    stdio: "ignore",
    windowsHide: true,
  });
  children.push(server);

  const workerFile = path.join(baseDir(), "worker", "worker.cjs");
  if (fs.existsSync(workerFile)) {
    children.push(spawn(nodeBin(), [workerFile], { env, stdio: "ignore", windowsHide: true }));
  }

  const secret = env.INTERNAL_SECRET || "";
  if (secret) {
    const drain = () =>
      fetch(`http://${HOST}:${PORT}/api/v1/cron/event-log-drain`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      }).catch(() => {});
    const timer = setInterval(drain, 60000);
    timer.unref?.();
  }
}

function openApp() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: "AVIA",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  win.loadURL(`http://${HOST}:${PORT}`);
}

function openSetup() {
  const win = new BrowserWindow({
    width: 600,
    height: 720,
    title: "AVIA — Configuração inicial",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, preload: path.join(baseDir(), "preload.js") },
  });
  win.loadFile(path.join(baseDir(), "setup.html"));
}

ipcMain.handle("avia:save-config", async (_evt, cfg) => {
  try {
    const lines = [
      `NEXT_PUBLIC_SUPABASE_URL=${cfg.url}`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${cfg.anon}`,
      `SUPABASE_SERVICE_ROLE_KEY=${cfg.service}`,
      `SUPABASE_DB_URL=${cfg.db}`,
      `GROQ_API_KEY=${cfg.groq}`,
      `NEXT_PUBLIC_APP_URL=http://${HOST}:${PORT}`,
      `NEXT_PUBLIC_ADMIN_URL=http://${HOST}:${PORT}`,
      `APP_NAME=AVIA`,
      `APP_LOGO_URL=/avia-logo.png`,
      `APP_ACCENT_HEX=#A98A50`,
    ];
    fs.mkdirSync(path.dirname(userEnvFile()), { recursive: true });
    fs.writeFileSync(userEnvFile(), lines.join("\n") + "\n", { mode: 0o600 });
    for (const win of BrowserWindow.getAllWindows()) win.close();
    await boot();
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: String((e && e.message) || e) };
  }
});

async function boot() {
  const env = loadEnv();
  if (!configCompleta(env)) return openSetup();
  startBackend();
  try {
    await waitForServer(`http://${HOST}:${PORT}/api/v1/health`);
  } catch {}
  openApp();
}

app.whenReady().then(boot);
app.on("window-all-closed", () => {
  for (const c of children) {
    try {
      c.kill();
    } catch {}
  }
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});
