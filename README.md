# VRChat MCP OSC

**VRChat MCP OSC** provides a bridge between AI assistants and VRChat using the Model Context Protocol (MCP), enabling AI-driven avatar control and interaction in virtual reality environments.

This is a fork of [Krekun/vrchat-mcp-osc](https://github.com/Krekun/vrchat-mcp-osc) with added **OSCQuery support** — the server can automatically discover VRChat's live parameter values without relying on VRChat broadcasting OSC output.

---

## What This Server Can Do

### Avatar information (via OSCQuery)

| Tool | What it returns |
|------|----------------|
| `get_avatar_name` | Current avatar's ID (e.g. `avtr_xxxx-...`) via OSCQuery; falls back to OSC-broadcast name |
| `get_avatar_parameters` | **Full parameter tree** with current live values, types, and read/write access — fetched directly from VRChat's OSCQuery HTTP endpoint, no OSC output required |

`get_avatar_parameters` returns a JSON array of objects like:
```json
[
  { "path": "/avatar/parameters/IsLocal",    "type": "T", "value": true,  "access": 1 },
  { "path": "/avatar/parameters/GestureLeft","type": "i", "value": 2,     "access": 3 },
  { "path": "/avatar/parameters/Viseme",     "type": "f", "value": 0.0,   "access": 3 }
]
```

OSC type strings: `"f"` = float, `"i"` = int, `"T"/"F"` = bool true/false, `"N"` = nil/no value, `"s"` = string.

### Avatar control (via OSC send)

| Tool | What it does |
|------|-------------|
| `set_avatar_parameter` | Set a named parameter to a value (float, int, or bool) |
| `set_emote_parameter` | Trigger a VRCEmote by number |
| `set_avatar` | Change to a specific avatar by ID |
| `get_avatar_list` | List available avatars from the relay |

### Movement & input

| Tool | What it does |
|------|-------------|
| `move_avatar` | Walk forward / backward / left / right for N seconds |
| `look_direction` | Turn left or right for N seconds |
| `jump` | Jump |
| `menu` | Toggle the VRChat quick menu |
| `voice` | Toggle mute |

### Communication

| Tool | What it does |
|------|-------------|
| `send_message` | Send a message to the VRChat chatbox (instantly or just populate it) |

---

## OSCQuery Auto-Discovery

VRChat 2023.4+ runs an **OSCQuery HTTP server** on a random TCP port and advertises it via mDNS. This fork discovers it automatically:

1. **Fast path (Windows)**: looks up VRChat's PID via `Get-Process VRChat`, then finds its listening TCP ports via `Get-NetTCPConnection` — completes in ~200 ms.
2. **mDNS fallback**: waits up to 3 s for VRChat to broadcast its `_oscjson._tcp` service announcement.

No port configuration needed. As long as VRChat is running with OSC enabled, parameter values are available immediately.

### OSC vs OSCQuery

| | Plain OSC | OSCQuery (this fork) |
|--|-----------|---------------------|
| Get parameter values | Only when VRChat broadcasts them (requires "OSC output" on) | Any time, by fetching VRChat's HTTP endpoint |
| Parameter types | Inferred from message | Explicitly declared |
| Discover all parameters | Not possible | Yes — full tree via one HTTP request |

---

## Requirements

- Node.js 18 or higher
- VRChat with **OSC enabled** (Settings → OSC → Enable)
- Windows (fast process-based discovery) or any platform (mDNS fallback works on macOS/Linux too)

---

## Setup (from source)

This package is not published to npm. Clone and build:

```bash
git clone https://github.com/misonyah/vrchat-mcp-osc
cd vrchat-mcp-osc

# Install dependencies (pnpm required — install with: npm i -g pnpm)
pnpm install

# Build all packages
pnpm -r build
```

### Configure Claude Desktop or Claude Code

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "vrchat-osc": {
      "command": "node",
      "args": ["C:/path/to/vrchat-mcp-osc/packages/mcp-server/dist/server.js"]
    }
  }
}
```

#### Claude Code (`.mcp.json` in project root)

```json
{
  "mcpServers": {
    "vrchat-osc": {
      "command": "node",
      "args": ["C:/Users/yourname/git/vrchat-mcp-osc/packages/mcp-server/dist/server.js"]
    }
  }
}
```

### Command-line options

| Option | Default | Description |
|--------|---------|-------------|
| `--osc-send-port <port>` | 9000 | Port VRChat listens on for OSC input |
| `--osc-send-ip <ip>` | 127.0.0.1 | VRChat OSC address |
| `--osc-receive-port <port>` | 9001 | Port to receive OSC output from VRChat |
| `--websocket-port <port>` | 8765 | Internal relay WebSocket port |
| `--debug` | off | Verbose logging to stderr |
| `--no-relay` | off | Skip the internal WebSocket relay (OSCQuery still works) |

---

## Troubleshooting

**Parameters come back empty**
- Make sure VRChat OSC is enabled: Settings → OSC → Enable
- Try restarting VRChat after enabling OSC

**`get_avatar_parameters` returns old/cached values after switching avatars**
- The OSCQuery port is cached per session. Restart Claude / the MCP server if you switch avatars and values look stale.

**OSCQuery not finding VRChat on a non-Windows machine**
- The fast path (process lookup) is Windows-only. mDNS fallback runs on all platforms but requires mDNS to be working on the network interface.

**MCP server not starting**
- Run `node packages/mcp-server/dist/server.js --debug` directly to see startup errors.

---

## Project Structure

```
vrchat-mcp-osc/
├── packages/
│   ├── mcp-server/          # MCP server + OSCQuery client
│   │   └── src/
│   │       ├── oscquery-client.ts   # OSCQuery discovery & parameter fetch
│   │       └── server.ts            # MCP tool definitions
│   ├── relay-server/        # WebSocket ↔ OSC relay
│   ├── types/               # Shared TypeScript types
│   └── utils/               # Logging utilities
└── pnpm-workspace.yaml
```

---

## License

Dual-licensed (same as upstream):
- **Non-commercial use**: MIT License
- **Commercial use**: requires a separate commercial license

## Acknowledgments

- [Krekun](https://github.com/Krekun) for the original vrchat-mcp-osc
- VRChat team for OSC and OSCQuery integration
- Anthropic for the Model Context Protocol
