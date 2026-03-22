#!/usr/bin/env node
const { execSync, execFileSync } = require("child_process");
const path = require("path");
const os = require("os");

const APP_SUPPORT = path.join(os.homedir(), "Library/Application Support/com.conductor.app");
const DB = path.join(APP_SUPPORT, "conductor.db");
// ─── SQLite ──────────────────────────────────────────────────────────────────

function sql(query) {
  try {
    const raw = execFileSync("sqlite3", ["-json", DB, query], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ─── ID resolution (prefix match) ───────────────────────────────────────────

function resolveSessionId(prefix) {
  const rows = sql(
    `SELECT id FROM sessions WHERE id LIKE '${prefix}%' ORDER BY updated_at DESC LIMIT 2;`
  );
  if (rows.length === 0) {
    console.error(`No session matching "${prefix}"`);
    process.exit(1);
  }
  if (rows.length > 1 && rows[0].id !== prefix) {
    console.error(`Ambiguous prefix "${prefix}" — matches multiple sessions. Be more specific.`);
    process.exit(1);
  }
  return rows[0].id;
}

// ─── YAML output ─────────────────────────────────────────────────────────────

function toYaml(obj, indent = 0) {
  const pad = "  ".repeat(indent);
  if (Array.isArray(obj)) {
    if (!obj.length) return "[]";
    return obj.map(item => {
      if (typeof item === "object" && item !== null) {
        const lines = toYaml(item, indent + 1).split("\n");
        return `${pad}- ${lines[0].trim()}\n${lines.slice(1).map(l => `${pad}  ${l.trim()}`).filter(l => l.trim()).join("\n")}`;
      }
      return `${pad}- ${item}`;
    }).join("\n");
  }
  if (typeof obj === "object" && obj !== null) {
    return Object.entries(obj)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => {
        if (typeof v === "object") return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        return `${pad}${k}: ${v}`;
      }).join("\n");
  }
  return `${obj}`;
}

function extractFlags(args, ...flags) {
  const found = new Set();
  const rest = args.filter(a => {
    for (const f of flags) {
      if (a === `--${f}`) { found.add(f); return false; }
    }
    return true;
  });
  return { args: rest, flags: found };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function statusColor(s) {
  if (s === "idle") return DIM;
  if (s === "busy") return GREEN;
  return RED;
}

function short(id) {
  return id?.substring(0, 8) || "????????";
}

function ago(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr.endsWith("Z") ? dateStr : dateStr + "Z");
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ─── Workspace title from git branch ────────────────────────────────────────

function getWorkspaceTitle(rootPath, directoryName, prTitle) {
  if (prTitle) return prTitle;
  if (!rootPath || !directoryName) return null;
  try {
    const cwd = path.join(rootPath, directoryName);
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!branch) return null;
    // Strip common prefixes like "woop/", "feat/", "fix/", etc. — take last segment after /
    const slug = branch.includes("/") ? branch.split("/").pop() : branch;
    // Convert hyphens to spaces, capitalize first letter
    return slug.replace(/-/g, " ").replace(/^\w/, c => c.toUpperCase());
  } catch {
    return null;
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

function cmdFind(args) {
  const { args: cleanArgs, flags } = extractFlags(args, "yaml");
  const yaml = flags.has("yaml");
  if (!cleanArgs.length) {
    console.error("Usage: conductor find <search terms> [--yaml]");
    process.exit(1);
  }
  const terms = cleanArgs.map(a => a.toLowerCase());
  const rows = sql(`
    SELECT s.id, s.status, s.agent_type, s.model, s.title,
           s.updated_at, w.directory_name, w.branch, r.name as repo,
           r.root_path,
           COALESCE(w.manual_status, w.derived_status) as stage,
           w.pr_title
    FROM sessions s
    LEFT JOIN workspaces w ON s.workspace_id = w.id
    LEFT JOIN repos r ON w.repository_id = r.id
    ORDER BY s.updated_at DESC;
  `);
  const enriched = rows.map(s => {
    const gitTitle = getWorkspaceTitle(s.root_path, s.directory_name, s.pr_title);
    return {
      ...s,
      gitTitle,
      displayTitle: gitTitle || s.title || "Untitled",
    };
  });
  const matches = enriched.filter(s => {
    const hay = [s.displayTitle, s.title, s.directory_name, s.branch, s.repo, s.stage].join(" ").toLowerCase();
    return terms.every(t => hay.includes(t));
  });

  if (yaml) {
    const data = matches.map(s => ({
      id: s.id,
      status: s.status,
      stage: s.stage || null,
      workspace: s.directory_name,
      repo: s.repo,
      title: s.displayTitle,
      session_title: s.title,
      updated_at: s.updated_at,
    }));
    return console.log(toYaml(data));
  }

  if (!matches.length) return console.log("No matches.");

  console.log(`${DIM}  ID        STATUS  STAGE        UPDATED     WORKSPACE            TITLE${RESET}`);
  for (const s of matches) {
    const c = statusColor(s.status);
    const stage = s.stage || "—";
    const sessionSuffix = s.gitTitle && s.title && s.title !== s.gitTitle ? `  ${DIM}(${s.title})${RESET}` : "";
    console.log(
      `  ${CYAN}${short(s.id)}${RESET}  ${c}${(s.status || "?").padEnd(6)}${RESET}  ` +
      `${stageColor(stage)}${stage.padEnd(11)}${RESET}  ` +
      `${DIM}${ago(s.updated_at).padEnd(10)}${RESET}  ` +
      `${(s.directory_name || "—").padEnd(20)}  ` +
      `${s.displayTitle}${sessionSuffix}`
    );
  }
  console.log(`${DIM}  ${matches.length} matches${RESET}`);
}

function stageColor(s) {
  if (s === "done") return GREEN;
  if (s === "in-review") return YELLOW;
  return DIM;
}

function formatStage(row) {
  const stage = row.manual_status || row.derived_status || "";
  if (!stage) return DIM + "—".padEnd(11) + RESET;
  return stageColor(stage) + stage.padEnd(11) + RESET;
}

function cmdSessions(args) {
  const { args: cleanArgs, flags } = extractFlags(args, "yaml");
  const yaml = flags.has("yaml");
  const limit = parseInt(cleanArgs[0]) || 30;
  const rows = sql(`
    SELECT s.id, s.status, s.agent_type, s.model, s.title,
           s.updated_at, w.directory_name, w.branch, r.name as repo,
           r.root_path,
           COALESCE(w.manual_status, w.derived_status) as stage,
           w.pr_title
    FROM sessions s
    LEFT JOIN workspaces w ON s.workspace_id = w.id
    LEFT JOIN repos r ON w.repository_id = r.id
    ORDER BY s.updated_at DESC LIMIT ${limit};
  `);

  if (yaml) {
    const data = rows.map(s => ({
      id: s.id,
      status: s.status,
      stage: s.stage || null,
      workspace: s.directory_name,
      repo: s.repo,
      title: getWorkspaceTitle(s.root_path, s.directory_name, s.pr_title) || s.title || null,
      session_title: s.title,
      updated_at: s.updated_at,
    }));
    return console.log(toYaml(data));
  }

  if (!rows.length) return console.log("No sessions.");

  console.log(`${DIM}  ID        STATUS  STAGE        UPDATED     WORKSPACE            TITLE${RESET}`);
  for (const s of rows) {
    const c = statusColor(s.status);
    const stage = s.stage || "—";
    const gitTitle = getWorkspaceTitle(s.root_path, s.directory_name, s.pr_title);
    const title = gitTitle || s.title || "Untitled";
    const sessionSuffix = gitTitle && s.title && s.title !== gitTitle ? `  ${DIM}(${s.title})${RESET}` : "";
    console.log(
      `  ${CYAN}${short(s.id)}${RESET}  ${c}${(s.status || "?").padEnd(6)}${RESET}  ` +
      `${stageColor(stage)}${stage.padEnd(11)}${RESET}  ` +
      `${DIM}${ago(s.updated_at).padEnd(10)}${RESET}  ` +
      `${(s.directory_name || "—").padEnd(20)}  ` +
      `${title}${sessionSuffix}`
    );
  }
  console.log(`${DIM}  ${rows.length} sessions${RESET}`);
}

function cmdWorkspaces(args) {
  const rows = sql(`
    SELECT w.id, w.directory_name, w.branch, w.state,
           r.name as repo, r.root_path
    FROM workspaces w
    LEFT JOIN repos r ON w.repository_id = r.id
    ORDER BY w.state = 'active' DESC, w.updated_at DESC LIMIT 50;
  `);
  if (!rows.length) return console.log("No workspaces.");

  console.log(`${DIM}  ID        STATE     WORKSPACE            REPO                 BRANCH${RESET}`);
  for (const w of rows) {
    const c = w.state === "active" ? GREEN : DIM;
    console.log(
      `  ${CYAN}${short(w.id)}${RESET}  ${c}${(w.state || "?").padEnd(8)}${RESET}  ` +
      `${(w.directory_name || "?").padEnd(20)}  ${(w.repo || "?").padEnd(20)}  ` +
      `${DIM}${w.branch || "?"}${RESET}`
    );
  }
}

function cmdRepos() {
  const rows = sql(`SELECT id, name, root_path, default_branch FROM repos ORDER BY display_order;`);
  if (!rows.length) return console.log("No repos.");

  console.log(`${DIM}  ID        NAME                 PATH${RESET}`);
  for (const r of rows) {
    console.log(`  ${CYAN}${short(r.id)}${RESET}  ${(r.name || "?").padEnd(20)}  ${DIM}${r.root_path}${RESET}`);
  }
}

function parseMessageText(content) {
  let text = content || "";
  try {
    const parsed = JSON.parse(text);
    if (parsed.type === "assistant" && parsed.message?.content) {
      const parts = [];
      for (const block of parsed.message.content) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "tool_use") parts.push(`[tool: ${block.name}]`);
        else if (block.type === "thinking") parts.push("[thinking...]");
      }
      return { text: parts.join("\n"), type: "assistant" };
    } else if (parsed.type === "result") {
      let t = `--- ${parsed.subtype} (${parsed.num_turns} turns, ${parsed.duration_ms}ms) ---`;
      if (parsed.result) t += `\n${parsed.result}`;
      return { text: t, type: "result" };
    } else if (parsed.type === "user") {
      const c = parsed.message?.content;
      const t = typeof c === "string" ? c : Array.isArray(c)
        ? c.map(x => x.type === "tool_result" ? "[tool_result]" : x.text || "").join(" ") : "";
      return { text: t, type: "user" };
    } else if (parsed.type === "system") {
      return { text: `[system: ${parsed.subtype}]`, type: "system" };
    }
  } catch {}
  return { text, type: "raw" };
}

function cmdMessages(args) {
  const { args: cleanArgs, flags } = extractFlags(args, "yaml", "full", "f");
  const yaml = flags.has("yaml");
  const full = flags.has("full") || flags.has("f");
  const prefix = cleanArgs[0];
  if (!prefix) {
    console.error("Usage: conductor messages <session-id> [limit] [--full] [--yaml]");
    process.exit(1);
  }
  const id = resolveSessionId(prefix);
  const limit = parseInt(cleanArgs[1]) || 30;
  const maxLen = full ? Infinity : 500;

  const session = sql(`SELECT s.title, s.agent_type, s.model, s.status, w.directory_name, w.pr_title, r.root_path
    FROM sessions s LEFT JOIN workspaces w ON s.workspace_id = w.id LEFT JOIN repos r ON w.repository_id = r.id
    WHERE s.id = '${id}';`)[0];
  const msgTitle = getWorkspaceTitle(session?.root_path, session?.directory_name, session?.pr_title) || session?.title || "Untitled";

  const total = sql(`SELECT count(*) as n FROM session_messages WHERE session_id = '${id}';`)[0]?.n || 0;

  const rows = sql(`
    SELECT role, content, created_at
    FROM session_messages WHERE session_id = '${id}'
    ORDER BY created_at DESC LIMIT ${limit};
  `);

  if (yaml) {
    const data = {
      session_id: id,
      title: msgTitle,
      status: session?.status,
      total_messages: total,
      messages: rows.reverse().map(m => {
        const { text, type } = parseMessageText(m.content);
        return { role: m.role, type, text: text.substring(0, full ? Infinity : 2000), created_at: m.created_at };
      }),
    };
    return console.log(toYaml(data));
  }

  console.log(`${BOLD}${msgTitle}${RESET}  ${DIM}(${session?.agent_type} / ${session?.model} / ${session?.status})${RESET}\n`);

  let truncated = 0;

  for (const m of rows.reverse()) {
    const isUser = m.role === "user";
    let { text } = parseMessageText(m.content);

    if (!isUser) {
      // Re-add formatting for terminal display
      try {
        const parsed = JSON.parse(m.content);
        if (parsed.type === "result") {
          text = `${DIM}--- ${parsed.subtype} (${parsed.num_turns} turns, ${parsed.duration_ms}ms) ---${RESET}`;
          if (parsed.result) text += `\n${parsed.result}`;
        } else if (parsed.type === "system") {
          text = `${DIM}[system: ${parsed.subtype}]${RESET}`;
        } else if (parsed.type === "assistant" && parsed.message?.content) {
          const parts = [];
          for (const block of parsed.message.content) {
            if (block.type === "text") parts.push(block.text);
            else if (block.type === "tool_use") parts.push(`[tool: ${block.name}]`);
            else if (block.type === "thinking") parts.push(`${DIM}[thinking...]${RESET}`);
          }
          text = parts.join("\n");
        }
      } catch {}
    }

    if (text.length > maxLen) {
      text = text.substring(0, maxLen) + `... ${DIM}(truncated)${RESET}`;
      truncated++;
    }

    const label = isUser ? `${GREEN}USER${RESET}` : `${CYAN}ASST${RESET}`;
    const time = `${DIM}${ago(m.created_at)}${RESET}`;
    console.log(`${label} ${time}`);
    console.log(`  ${text.replace(/\n/g, "\n  ")}\n`);
  }

  const showing = rows.length;
  const hints = [];
  if (showing < total) hints.push(`use ${CYAN}conductor m ${short(id)} ${total}${RESET} to see all`);
  if (truncated > 0) hints.push(`use ${CYAN}--full${RESET} to show untruncated messages`);
  console.log(`${DIM}Showing ${showing} of ${total} messages${hints.length ? " · " + hints.join(" · ") : ""}${RESET}`);
}

function cmdListen(args) {
  const filter = args[0] ? resolveSessionId(args[0]) : null;
  const interval = 2; // seconds

  console.log(filter ? `Watching session ${CYAN}${short(filter)}${RESET}...` : "Watching all sessions...");
  console.log(`${DIM}Polling DB every ${interval}s. Ctrl+C to stop.${RESET}\n`);

  // Track last seen message per session
  const lastSeen = new Map();

  // Initialize with current latest message timestamps
  const initQuery = filter
    ? `SELECT session_id, max(created_at) as latest FROM session_messages WHERE session_id = '${filter}' GROUP BY session_id;`
    : `SELECT session_id, max(created_at) as latest FROM session_messages GROUP BY session_id;`;
  for (const r of sql(initQuery)) {
    lastSeen.set(r.session_id, r.latest);
  }

  const poll = () => {
    const conditions = [];
    if (filter) conditions.push(`sm.session_id = '${filter}'`);

    // Get new messages since last seen for each session
    const allNew = [];
    const sessions = filter ? [filter] : sql(`SELECT id FROM sessions WHERE status = 'busy';`).map(r => r.id);

    for (const sid of sessions) {
      const since = lastSeen.get(sid);
      const whereTime = since ? `AND sm.created_at > '${since}'` : "";
      const rows = sql(`
        SELECT sm.session_id, sm.role, sm.content, sm.created_at
        FROM session_messages sm
        WHERE sm.session_id = '${sid}' ${whereTime}
        ORDER BY sm.created_at ASC LIMIT 50;
      `);
      for (const r of rows) allNew.push(r);
    }

    for (const m of allNew) {
      lastSeen.set(m.session_id, m.created_at);
      const tag = `${DIM}[${short(m.session_id)}]${RESET}`;
      let text = m.content || "";

      try {
        const parsed = JSON.parse(text);
        if (parsed.type === "assistant" && parsed.message?.content) {
          for (const b of parsed.message.content) {
            if (b.type === "text") console.log(`${tag} ${b.text}`);
            else if (b.type === "tool_use") console.log(`${tag} ${YELLOW}[tool: ${b.name}]${RESET}`);
          }
          continue;
        } else if (parsed.type === "result") {
          console.log(`${tag} ${GREEN}--- ${parsed.subtype} (${parsed.num_turns} turns, ${parsed.duration_ms}ms) ---${RESET}`);
          continue;
        } else if (parsed.type === "user") {
          const content = parsed.message?.content;
          text = typeof content === "string" ? content : "";
        }
      } catch {}

      if (text && m.role === "user") {
        console.log(`${tag} ${GREEN}USER:${RESET} ${text.substring(0, 200)}`);
      }
    }
  };

  const timer = setInterval(poll, interval * 1000);
  process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });
}

// ─── AppleScript UI automation ──────────────────────────────────────────────

function runJxa(code) {
  return execFileSync("osascript", ["-l", "JavaScript", "-e", code], {
    encoding: "utf8",
    timeout: 15000,
  }).trim();
}

function uiNavigateToWorkspace(branchName) {
  const escaped = branchName.replace(/\\/g, "\\\\").replace(/"/g, '\\"').toLowerCase();
  const result = runJxa(`
    function run() {
      var app = Application("System Events");
      var proc = app.processes.byName("Conductor");
      Application("Conductor").activate();
      delay(0.3);
      var html = proc.windows[0].groups[0].groups[0].scrollAreas[0].uiElements[0];
      var texts = html.staticTexts();
      var target = "${escaped}";
      for (var i = 0; i < texts.length; i++) {
        try {
          var val = (texts[i].value() || "").toLowerCase();
          if (val === target) {
            texts[i].actions["AXPress"].perform();
            return "ok";
          }
        } catch(e) {}
      }
      return "not_found";
    }
    run();
  `);
  if (result === "not_found") {
    console.error(`Workspace "${branchName}" not visible in sidebar. Try scrolling or check the name.`);
    process.exit(1);
  }
}

function uiTypePrompt(message) {
  // Activate, type, and submit — must be in ONE osascript call to avoid double-keystroke
  const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  runJxa(`
    Application("Conductor").activate();
    delay(0.5);
    var se = Application("System Events");
    se.keystroke("${escaped}");
    delay(0.3);
    se.keyCode(36);
  `);
}

function resolveWorkspaceBranch(identifier) {
  // Resolve a branch name from a branch, workspace directory, session ID prefix, or title substring
  // 1. Exact branch match
  let rows = sql(`SELECT directory_name FROM workspaces WHERE directory_name = '${identifier.replace(/'/g, "''")}' AND state != 'archived' LIMIT 1;`);
  if (rows.length) return rows[0].directory_name;

  // 2. Session ID prefix → workspace branch
  rows = sql(`
    SELECT w.directory_name FROM sessions s
    JOIN workspaces w ON s.workspace_id = w.id
    WHERE s.id LIKE '${identifier.replace(/'/g, "''")}%' AND w.state != 'archived'
    ORDER BY s.updated_at DESC LIMIT 1;
  `);
  if (rows.length) return rows[0].directory_name;

  // 3. Title substring match (DB session title)
  rows = sql(`
    SELECT w.directory_name FROM sessions s
    JOIN workspaces w ON s.workspace_id = w.id
    WHERE s.title LIKE '%${identifier.replace(/'/g, "''")}%' AND w.state != 'archived'
    ORDER BY s.updated_at DESC LIMIT 1;
  `);
  if (rows.length) return rows[0].directory_name;

  // 3b. Git branch-derived title match
  const allWs = sql(`
    SELECT w.directory_name, r.root_path, w.pr_title FROM workspaces w
    LEFT JOIN repos r ON w.repository_id = r.id
    WHERE w.state != 'archived';
  `);
  const lowerIdent = identifier.toLowerCase();
  for (const w of allWs) {
    const t = getWorkspaceTitle(w.root_path, w.directory_name, w.pr_title);
    if (t && t.toLowerCase().includes(lowerIdent)) return w.directory_name;
  }

  // 4. Branch substring match
  rows = sql(`SELECT directory_name FROM workspaces WHERE directory_name LIKE '%${identifier.replace(/'/g, "''")}%' AND state != 'archived' LIMIT 1;`);
  if (rows.length) return rows[0].directory_name;

  console.error(`No active workspace matching "${identifier}"`);
  process.exit(1);
}

function cmdGo(args) {
  if (!args.length) {
    console.error("Usage: conductor go <branch|session-id|title>");
    process.exit(1);
  }
  const branch = resolveWorkspaceBranch(args.join(" "));
  console.log(`${DIM}Navigating to ${CYAN}${branch}${RESET}${DIM}...${RESET}`);
  uiNavigateToWorkspace(branch);
  console.log(`${GREEN}Done${RESET}`);
}

function cmdArchive(args) {
  if (!args.length) {
    console.error("Usage: conductor archive <branch|session-id|title>");
    process.exit(1);
  }
  const branch = resolveWorkspaceBranch(args.join(" "));
  console.log(`${DIM}Archiving ${CYAN}${branch}${RESET}${DIM}...${RESET}`);
  uiNavigateToWorkspace(branch);
  execSync("sleep 0.5");
  runJxa(`
    Application("Conductor").activate();
    delay(0.3);
    var se = Application("System Events");
    se.keystroke("a", { using: ["command down", "shift down"] });
  `);
  console.log(`${GREEN}Done${RESET}`);
}

function cmdNew(args) {
  const { args: cleanArgs, flags } = extractFlags(args, "yaml");
  const yaml = flags.has("yaml");

  if (!cleanArgs.length) {
    const repos = sql(`SELECT name, display_order FROM repos ORDER BY display_order;`);
    console.error("Usage: conductor new <repo-name> [--yaml]");
    console.error(`\n${DIM}Available repos:${RESET}`);
    for (const r of repos) {
      console.error(`  ${r.display_order + 1}. ${r.name}`);
    }
    process.exit(1);
  }

  const identifier = cleanArgs.join(" ").toLowerCase();
  const repos = sql(`SELECT id, name, display_order FROM repos ORDER BY display_order;`);
  const repo = repos.find(r => r.name.toLowerCase() === identifier)
    || repos.find(r => r.name.toLowerCase().includes(identifier));

  if (!repo) {
    console.error(`No repo matching "${cleanArgs.join(" ")}"`);
    process.exit(1);
  }

  // Snapshot current workspaces for this repo
  const before = new Set(
    sql(`SELECT id FROM workspaces WHERE repository_id = '${repo.id}';`).map(w => w.id)
  );

  const keyNum = repo.display_order + 1;
  if (!yaml) console.log(`${DIM}Creating workspace in ${CYAN}${repo.name}${RESET}${DIM}...${RESET}`);

  runJxa(`
    Application("Conductor").activate();
    delay(0.3);
    var se = Application("System Events");
    se.keystroke("n", { using: "command down" });
    delay(0.5);
    se.keystroke("${keyNum}");
  `);

  // Poll for the new workspace to appear
  let newWs = null;
  for (let i = 0; i < 30; i++) {
    execSync("sleep 0.5");
    const current = sql(`SELECT id, directory_name, branch FROM workspaces WHERE repository_id = '${repo.id}' ORDER BY created_at DESC;`);
    const fresh = current.find(w => !before.has(w.id));
    if (fresh) {
      newWs = fresh;
      break;
    }
  }

  if (yaml) {
    return console.log(toYaml({
      repo: repo.name,
      workspace: newWs?.directory_name || null,
      branch: newWs?.branch || null,
    }));
  }

  if (newWs) {
    console.log(`${GREEN}Created${RESET} ${CYAN}${newWs.directory_name}${RESET}`);
  } else {
    console.log(`${GREEN}Done${RESET} ${DIM}(workspace name not yet available)${RESET}`);
  }
}

function cmdSay(args) {
  const { args: cleanArgs, flags } = extractFlags(args, "wait", "w", "yaml");
  const wait = flags.has("wait") || flags.has("w");
  const yaml = flags.has("yaml");

  if (cleanArgs.length < 2) {
    console.error("Usage: conductor say <target> <message...> [--wait] [--yaml]");
    process.exit(1);
  }

  const identifier = cleanArgs[0];
  const message = cleanArgs.slice(1).join(" ");
  const branch = resolveWorkspaceBranch(identifier);

  if (!yaml) console.log(`${DIM}Navigating to ${CYAN}${branch}${RESET}${DIM}...${RESET}`);
  uiNavigateToWorkspace(branch);

  execSync("sleep 1.5");

  if (!yaml) console.log(`${DIM}Typing prompt...${RESET}`);
  uiTypePrompt(message);
  if (!yaml) console.log(`${GREEN}Sent:${RESET} "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`);

  if (wait) {
    const sessionRow = sql(`
      SELECT s.id FROM sessions s
      JOIN workspaces w ON s.workspace_id = w.id
      WHERE w.directory_name = '${branch.replace(/'/g, "''")}' AND w.state != 'archived'
      ORDER BY s.updated_at DESC LIMIT 1;
    `);
    if (sessionRow.length) {
      const sid = sessionRow[0].id;
      if (!yaml) console.log(`${DIM}Waiting for completion (${short(sid)})...${RESET}`);

      // Wait for session to become busy first (it takes a moment after submit)
      for (let i = 0; i < 10; i++) {
        execSync("sleep 1");
        const status = sql(`SELECT status FROM sessions WHERE id = '${sid}';`)[0]?.status;
        if (status === "busy") break;
      }

      // Then wait for it to finish
      for (let i = 0; i < 600; i++) {
        execSync("sleep 1");
        const status = sql(`SELECT status FROM sessions WHERE id = '${sid}';`)[0]?.status;
        if (status === "idle" || status === "error") {
          if (yaml) {
            // Get the last assistant message
            const lastMsg = sql(`SELECT content, created_at FROM session_messages
              WHERE session_id = '${sid}' AND role = 'assistant'
              ORDER BY created_at DESC LIMIT 1;`)[0];
            const { text } = parseMessageText(lastMsg?.content);
            return console.log(toYaml({
              workspace: branch,
              session_id: sid,
              status,
              response: text.substring(0, 2000),
            }));
          }
          console.log(`${GREEN}Agent finished${RESET} (status: ${status})`);
          break;
        }
      }
    }
  } else if (yaml) {
    console.log(toYaml({ workspace: branch, sent: message }));
  }
}

function cmdStatus(args) {
  const { flags } = extractFlags(args || [], "yaml");
  const yaml = flags.has("yaml");

  const sessions = sql(`SELECT status, count(*) as n FROM sessions GROUP BY status;`);
  const repoCount = sql(`SELECT count(*) as n FROM repos;`);
  const workspaces = sql(`SELECT state, count(*) as n FROM workspaces GROUP BY state;`);

  const sMap = Object.fromEntries(sessions.map(s => [s.status, s.n]));
  const wsMap = Object.fromEntries(workspaces.map(w => [w.state, w.n]));

  if (yaml) {
    return console.log(toYaml({
      repos: repoCount[0]?.n || 0,
      workspaces_active: wsMap.active || 0,
      workspaces_archived: wsMap.archived || 0,
      sessions_idle: sMap.idle || 0,
      sessions_busy: sMap.busy || 0,
      sessions_error: sMap.error || 0,
    }));
  }

  console.log(`${BOLD}Conductor${RESET}\n`);
  console.log(`  Repos:      ${repoCount[0]?.n || 0}`);
  console.log(`  Workspaces: ${wsMap.active || 0} active, ${wsMap.archived || 0} archived`);
  console.log(`  Sessions:   ${sMap.idle || 0} idle, ${sMap.busy || 0} busy, ${sMap.error || 0} error`);
  console.log();
}

// ─── Main ────────────────────────────────────────────────────────────────────

const HELP = `
${BOLD}conductor${RESET} - terminal control for Conductor

${BOLD}Usage:${RESET}
  conductor <command> [args]

${BOLD}Commands:${RESET}
  status                           Overview of Conductor state
  sessions [limit]                 List sessions (alias: s)
  workspaces                       List workspaces (alias: w)
  repos                            List repositories (alias: r)
  messages <session-id> [limit]    Show message history [--full] (alias: m)
  find <terms...>                  Search sessions (alias: f)
  listen [session-id]              Watch for new messages (alias: l)
  go <target>                      Navigate Conductor UI to a workspace
  say <target> <msg>               Navigate + type prompt + submit [--wait]
  new <repo>                       Create a new workspace in a repo
  archive <target>                 Archive a workspace

${DIM}Session IDs support prefix matching (e.g. "4089" instead of the full UUID).
Targets can be branch names, session ID prefixes, or title substrings.${RESET}
`;

function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "status":      return cmdStatus(args);
    case "sessions":    return cmdSessions(args);
    case "s":           return cmdSessions(args);
    case "workspaces":  return cmdWorkspaces(args);
    case "w":           return cmdWorkspaces(args);
    case "repos":       return cmdRepos();
    case "r":           return cmdRepos();
    case "messages":    return cmdMessages(args);
    case "m":           return cmdMessages(args);
    case "find":        return cmdFind(args);
    case "f":           return cmdFind(args);
    case "listen":      return cmdListen(args);
    case "l":           return cmdListen(args);
    case "go":          return cmdGo(args);
    case "say":         return cmdSay(args);
    case "new":         return cmdNew(args);
    case "n":           return cmdNew(args);
    case "archive":     return cmdArchive(args);
    case "a":           return cmdArchive(args);
    default:            console.log(HELP);
  }
}

main();
