/**
 * Prepara electron/dist para o electron-builder:
 *   dist/worker.cjs        agente 24/7 bundleado (esbuild)
 *   dist/node-runtime/<so> Node embarcado (sem Node no PC do cliente)
 *   dist/avia.env            config (copiada do .env.local — REVISAR segredos!)
 *   build/icon.ico           ícone Windows (da logo oficial)
 *
 * Uso (na raiz do repo):
 *   node electron/scripts/prepare-dist.mjs --platform win
 *   node electron/scripts/prepare-dist.mjs --platform mac
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ELECTRON = path.join(ROOT, "electron");
const DIST = path.join(ELECTRON, "dist");
const args = process.argv.slice(2);
let platform = "win";
const eq = args.find((a) => a.startsWith("--platform="));
if (eq) platform = eq.split("=")[1];
const sp = args.indexOf("--platform");
if (sp !== -1 && args[sp + 1]) platform = args[sp + 1];

function sh(cmd, opts = {}) {
  console.log("$", cmd);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, "node-runtime"), { recursive: true });

// 1. Worker bundleado (esbuild é devDependency — binário local, sem npx)
const ESBUILD =
  process.platform === "win32"
    ? path.join(ROOT, "node_modules", ".bin", "esbuild.cmd")
    : path.join(ROOT, "node_modules", ".bin", "esbuild");
sh(
  `"${ESBUILD}" workers/agent-worker/main.ts --bundle --platform=node --format=cjs --alias:@=. --outfile=electron/dist/worker.cjs --log-level=warning`,
);

// 2. Node embarcado (último v22 LTS)
const index = JSON.parse(
  execSync(`node -e "fetch('https://nodejs.org/dist/index.json').then(r=>r.text()).then(t=>console.log(t))"`, {
    encoding: "utf8",
  }),
);
const v22 = index.find((v) => v.version.startsWith("v22."));
if (!v22) throw new Error("não achei o Node 22 em nodejs.org/dist");
console.log("Node embarcado:", v22.version);
if (platform === "win") {
  const zip = `node-${v22.version}-win-x64.zip`;
  sh(`curl -fsSL https://nodejs.org/dist/${v22.version}/${zip} -o electron/dist/node.zip`, { cwd: ROOT });
  fs.mkdirSync(path.join(DIST, "node-runtime", "win"), { recursive: true });
  // `tar` existe no Windows 10+ e lê .zip — evita Expand-Archive (só PowerShell).
  sh(`tar -xf electron/dist/node.zip -C electron/dist`);
  fs.copyFileSync(
    path.join(DIST, `node-${v22.version}-win-x64`, "node.exe"),
    path.join(DIST, "node-runtime", "win", "node.exe"),
  );
  fs.rmSync(path.join(DIST, `node-${v22.version}-win-x64`), { recursive: true, force: true });
  fs.rmSync(path.join(DIST, "node.zip"), { force: true });
} else {
  const tgz = `node-${v22.version}-darwin-arm64.tar.gz`;
  sh(`curl -fSL https://nodejs.org/dist/${v22.version}/${tgz} -o electron/dist/node.tgz`);
  fs.mkdirSync(path.join(DIST, "node-runtime", "mac"), { recursive: true });
  sh(`tar -xzf electron/dist/node.tgz -C electron/dist && cp electron/dist/node-${v22.version}-darwin-arm64/bin/node electron/dist/node-runtime/mac/node && rm -rf electron/dist/node-${v22.version}-darwin-arm64 electron/dist/node.tgz`);
}

// 3. avia.env MODELO (sem segredos!): o programa pede as chaves na
// primeira abertura (setup.html) e grava em userData. Distribuir segredo
// dentro do instalador entregaria a service_role a quem extrair o pacote.
const MODELO_ENV = `# AVIA Desktop — complete na primeira abertura do programa.
# Cada instalação deve ter o SEU Supabase e a SUA chave de IA.
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_URL=
GROQ_API_KEY=
APP_NAME=AVIA
APP_LOGO_URL=/avia-logo.png
APP_ACCENT_HEX=#A98A50
`;
fs.writeFileSync(path.join(DIST, "avia.env"), MODELO_ENV);
console.log("OK: dist pronto (avia.env modelo, sem segredos).");
