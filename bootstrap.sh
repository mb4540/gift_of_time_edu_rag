#!/usr/bin/env bash
set -euo pipefail

echo "== Gift of Time bootstrap (Netlify-only) =="

# ---- sanity checks ----
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js not found. Please install Node 20+ (nvm recommended)." >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js >= 20 required. Current: $(node -v)" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm not found (should come with Node)." >&2
  exit 1
fi

# ---- Netlify CLI ----
if ! command =v netlify >/dev/null 2>&1; then
  echo "Installing Netlify CLI globally..."
  npm i -g netlify-cli
else
  echo "Netlify CLI found: $(netlify --version)"
fi

# ---- repo scaffold ----
mkdir -p web
mkdir -p netlify/functions/api
mkdir -p netlify/functions/background
mkdir -p netlify/functions/scheduled

# .gitignore
if [ ! -f .gitignore ]; then
cat > .gitignore <<'IGN'
node_modules/
.env
.netlify/
dist/
.cache/
.DS_Store
IGN
fi

# package.json (create if missing)
if [ ! -f package.json ]; then
  npm init -y >/dev/null
  # set type=module and scripts
  node - <<'JS'
const fs=require('fs');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
pkg.type = 'module';
pkg.scripts = {
  dev: "netlify dev",
  build: "echo build-skip",
  lint: "echo (add eslint later)"
};
fs.writeFileSync('package.json', JSON.stringify(pkg,null,2));
JS
fi

# tsconfig
if [ ! -f tsconfig.json ]; then
cat > tsconfig.json <<'TS'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["netlify/**/*.ts"]
}
TS
fi

# netlify.toml
if [ ! -f netlify.toml ]; then
cat > netlify.toml <<'TOML'
[build]
  publish = "web"

# Route /api/* to Functions
[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/:splat"
  status = 200

# Example scheduled function (enable in a later milestone)
#[[scheduled.functions]]
#  name = "nightly-maintenance"
#  cron = "0 3 * * *" # 03:00 UTC daily
TOML
fi

# Minimal index.html with a health check
if [ ! -f web/index.html ]; then
cat > web/index.html <<'HTML'
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Gift of Time — Bootstrap</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; }
    button { padding: .6rem 1rem; }
    pre { background: #f6f6f6; padding: 1rem; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>Gift of Time — Bootstrap</h1>
  <p>This is the Milestone 0 scaffold. Click below to validate the health function.</p>
  <button id="check">Check Health</button>
  <pre id="out">(waiting)</pre>
  <script>
    const out = document.getElementById('out');
    document.getElementById('check').onclick = async () => {
      out.textContent = 'Fetching...';
      try {
        const res = await fetch('/api/health');
        const json = await res.json();
        out.textContent = JSON.stringify(json, null, 2);
      } catch (e) {
        out.textContent = 'Error: ' + e;
      }
    };
  </script>
</body>
</html>
HTML
fi

# health function
if [ ! -f netlify/functions/api/health.ts ]; then
cat > netlify/functions/api/health.ts <<'TS'
export default async () => {
  return new Response(
    JSON.stringify({ ok: true, time: new Date().toISOString() }),
    { headers: { "content-type": "application/json" } }
  );
};
TS
fi

# local deps
echo "Installing local dev dependencies (typescript, @types/node)..."
npm i -D typescript @types/node >/dev/null

# optional runtime deps (minimal now)
echo "Installing runtime deps (none yet)..."

# .env template
if [ ! -f .env ]; then
cat > .env <<'ENV'
# Local development only. Netlify will inject env vars in production.
OPENAI_API_KEY=sk-REPLACE_ME
# Netlify injects DB/Blobs URLs automatically when linked.
ENV
fi

echo "== Done =="
echo "Next:"
echo "  1) netlify login"
echo "  2) netlify init   # link to your site (publish dir: web)"
echo "  3) netlify dev    # open http://localhost:8888 and click 'Check Health'"
