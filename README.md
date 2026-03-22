# conductor-cli

Terminal control for [Conductor](https://conductor.build). Read session data from SQLite, send prompts via UI automation.

## Setup

```bash
git clone https://github.com/woop/conductor-cli.git ~/conductor-cli
echo 'alias conductor="node ~/conductor-cli/conductor-client.js"' >> ~/.zshrc
source ~/.zshrc
```

**Requirements:** macOS, Node.js, Conductor running, `/usr/bin/osascript` in System Settings > Privacy & Security > Accessibility.

## Commands

### Read

```bash
conductor status                          # Overview
conductor sessions [limit]                # List sessions (alias: s)
conductor workspaces                      # List workspaces (alias: w)
conductor repos                           # List repositories (alias: r)
conductor messages <session-id> [limit]   # Message history (alias: m) [--full]
conductor find <terms...>                 # Search sessions (alias: f)
conductor listen [session-id]             # Watch for new messages (alias: l)
```

### Write

```bash
conductor go <target>                     # Navigate to a workspace
conductor say <target> <message>          # Navigate + type prompt + submit [--wait]
conductor new <repo>                      # Create a new workspace (alias: n)
conductor archive <target>                # Archive a workspace (alias: a)
```

### Machine-readable output

Most commands support `--yaml` for programmatic use (e.g. `conductor sessions --yaml`).

### Target resolution

The `go`, `say`, and `archive` commands resolve workspace targets flexibly:

1. **Branch name** - `pompeii`, `tashkent-v1`
2. **Session ID prefix** - `6d62`, `4089beb7`
3. **Title substring** - `"struct cleanup"`, `"run tests"`
4. **Branch substring** - `tashkent` matches `tashkent-v1`

## How it works

```
┌──────────────┐                      ┌──────────────┐
│  Conductor   │  read/write          │ conductor-cli│
│  (Tauri App) │                      │  (this tool) │
└──────────────┘                      └──────────────┘
       │                                   │     │
       │ read/write                   read │     │ JXA
       ▼                                   │     ▼
┌──────────────┐                      ┌──────────────┐
│   SQLite DB  │◄─────────────────────│ Conductor UI │
└──────────────┘                      └──────────────┘
```

- **Reading** - Direct SQLite queries against the Conductor DB. Fast, no side effects.
- **Writing** (`say`, `go`, `new`, `archive`) - JXA automation clicks sidebar items and types prompts. The frontend handles everything natively, so the UI updates in real-time.
- **Watching** (`listen`) - Polls the DB for new messages.
