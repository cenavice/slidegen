Node 24 zero-dependency slide generator.

server.js     — static file server + POST /generate proxy to OpenCode Go
public/       — browser UI (prompt -> deck preview -> download)
design/       — design system prompts shipped to the LLM as system messages

Run:  OPENCODE_API_KEY=... node server.js         (local, http://localhost:3000)
      or: docker compose up --build              (http://localhost:3000)

Config via env:
  OPENCODE_API_KEY  required
  SLIDEGEN_MODEL    default mimo-v2.5
  SLIDEGEN_BASE_URL default https://opencode.ai/zen/go/v1
  PORT              default 3000
