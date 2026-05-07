# OpenCode Control Surface

A mobile-friendly web control surface for OpenCode sessions, built as Phase 1 of a larger control panel initiative.

## Quick Start

### Prerequisites

- Bun 1.3+
- OpenCode server running (local or remote)
- Optional: Ollama for local model status

### Local Development

```bash
# Install dependencies
bun install

# Start development server
bun run dev

# Open http://localhost:5173
```

### Docker

```bash
# Build
docker build -t control-surface .

# Run with environment
docker run -d -p 3000:3000 \
  -e OPENCODE_SERVER_URL=http://host.docker.internal:4096 \
  control-surface
```

### docker-compose

```bash
docker-compose up -d
```

## Configuration

Copy `.env.example` to `.env` and configure:

```
OPENCODE_SERVER_URL=http://localhost:4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=your-password
```

## Features (Phase 1)

- Connect to existing OpenCode server
- List and manage sessions
- Create new sessions
- Stream messages in real-time
- Model selector with hosted/local categorization
- Local model busy detection (Ollama adapter)

## Local Model Busy Detection

The app checks local model status via HTTP polling:

1. **Ollama adapter**: Queries `/api/tags` for running models
2. **Status states**: available | busy | offline | error
3. **When busy**: Shows "model busy" - hosted models remain usable
4. **Does NOT**: Kill, steal, or preempt running local models

### Adding Local Model Hosts

Add adapters in `server/adapters/models/`:
- `ollama.ts` - Already included
- Create `lmstudio.ts` following the same pattern
- Register in `server/adapters/models/registry.ts`

## What Is Intentionally Out of Scope

Phase 1 omits:
- Dashboard/statistics pages
- Host/resource monitoring
- Pause/resume session controls
- Agent lifecycle management
- Full orchestration layer
- Prometheus/Hetzner/Obsidian MCP integration

These will be addressed in Phase 2+.

## Architecture

```
┌─────────────────────────────────────┐
│            UI Layer                  │
│  (TanStack Start, React, Tailwind)  │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│        OpenCode Adapter             │
│  (@opencode-ai/sdk client)         │
│  server/adapters/opencode/        │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│        Host Adapters               │
│  (Ollama, LMStudio status)        │
│  server/adapters/models/         │
└─────────────────────────────────────┘
```

## Why SDK/Server-First

This is NOT a terminal emulator. It uses:
- Official OpenCode SDK for type-safe API interaction
- HTTP/SSE for real-time streaming
- Standard REST patterns that work with any OpenCode server

This approach:
- Works without local models mounted
- Supports remote/hosted models
- Is future-proof for multi-server setups

## Cloudflare Deployment

Add to your Caddyfile:

```
control.example.com {
  reverse_proxy localhost:3000
}
```

Or use Cloudflare Tunnel for external access.

## Project Structure

```
├── app/                    # TanStack Start app
│   ├── components/         # React components
│   ├── hooks/              # Custom hooks
│   ├── lib/                # Zustand store
│   └── routes/             # Route definitions
├── server/
│   ├── adapters/
│   │   ├── opencode/       # OpenCode SDK client
│   │   └── models/         # Local model adapters
│   ├── domain/             # Domain types
│   └── services/          # Business logic
├── docker/                 # Dockerfile
├── .opencode/skills/       # OpenCode skills
└── .env.example           # Environment template
```

## License

MIT