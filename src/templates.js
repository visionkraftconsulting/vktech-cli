// Template engine for vktech `audit`.
// A template is a markdown file in templates/ with YAML-ish frontmatter:
//
//   ---
//   name: hipaa-iso
//   title: HIPAA / ISO 27001 / SOC2 production-readiness audit
//   model: gpt-5
//   include:
//     - apps/**/src/routes/*.js
//     - docs/trust/*.md
//   ---
//   <the instruction prompt body>
//
// The body becomes the instruction; matched files are appended as fenced blocks.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

// --- tiny glob: supports **, *, and ? against POSIX-style relative paths ---
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** -> match across directory separators
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // consume trailing slash of **/
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

function walk(dir, baseDir, acc, depth = 0) {
  if (depth > 12) return acc;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" ||
        e.name === ".next" || e.name === "build" || e.name === ".turbo") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, baseDir, acc, depth + 1);
    else acc.push(relative(baseDir, full).split("\\").join("/"));
  }
  return acc;
}

export function matchFiles(baseDir, patterns) {
  const all = walk(baseDir, baseDir, []);
  const regexes = patterns.map(globToRegExp);
  const seen = new Set();
  const out = [];
  for (const rel of all) {
    if (regexes.some((r) => r.test(rel)) && !seen.has(rel)) {
      seen.add(rel);
      out.push(rel);
    }
  }
  return out.sort();
}

// Minimal frontmatter parser (no YAML dep). Handles scalars and "- " list items.
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let currentKey = null;
  for (const line of m[1].split("\n")) {
    if (/^\s*-\s+/.test(line) && currentKey) {
      (meta[currentKey] ||= []).push(line.replace(/^\s*-\s+/, "").trim());
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      const val = kv[2].trim();
      meta[currentKey] = val === "" ? [] : val;
    }
  }
  return { meta, body: m[2].trim() };
}

export function templatesDir(root) {
  return join(root, "templates");
}

export function listTemplates(root) {
  const dir = templatesDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { meta } = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
      return {
        file: f,
        name: meta.name || f.replace(/\.md$/, ""),
        title: meta.title || "",
        model: meta.model || "gpt-5",
        include: Array.isArray(meta.include) ? meta.include : [],
      };
    });
}

export function loadTemplate(root, nameOrFile) {
  const dir = templatesDir(root);
  const candidates = [
    join(dir, nameOrFile),
    join(dir, `${nameOrFile}.md`),
  ];
  let path = candidates.find(existsSync);
  if (!path) {
    // match by frontmatter name
    const hit = listTemplates(root).find((t) => t.name === nameOrFile);
    if (hit) path = join(dir, hit.file);
  }
  if (!path) return null;
  const raw = readFileSync(path, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  return {
    path,
    name: meta.name || nameOrFile,
    title: meta.title || "",
    model: meta.model || "gpt-5",
    include: Array.isArray(meta.include) ? meta.include : [],
    body,
  };
}

const LANG_BY_EXT = {
  ".js": "javascript", ".ts": "typescript", ".tsx": "tsx", ".jsx": "jsx",
  ".py": "python", ".go": "go", ".rs": "rust", ".json": "json",
  ".sh": "bash", ".sql": "sql", ".md": "markdown", ".yml": "yaml", ".yaml": "yaml",
};

// Build the full prompt: instruction body + project tree + matched file contents.
// Returns { prompt, files, bytes }. Respects a soft byte budget (skips overflow, notes it).
export function buildPrompt({ root, targetDir, template, maxBytes = 600_000 }) {
  const files = matchFiles(targetDir, template.include);
  let body = template.body + "\n\n";
  body += "# PROJECT FILES INCLUDED\n```\n" + files.join("\n") + "\n```\n\n";

  let used = Buffer.byteLength(body, "utf8");
  const skipped = [];
  for (const rel of files) {
    const abs = join(targetDir, rel);
    let content;
    try {
      if (statSync(abs).size > 400_000) { skipped.push(rel + " (too large)"); continue; }
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lang = LANG_BY_EXT[extname(rel)] || "";
    const block =
      "================================================================================\n" +
      `FILE: ${rel}\n` +
      "================================================================================\n" +
      "```" + lang + "\n" + content + "\n```\n\n";
    const blen = Buffer.byteLength(block, "utf8");
    if (used + blen > maxBytes) { skipped.push(rel + " (budget)"); continue; }
    body += block;
    used += blen;
  }
  if (skipped.length) {
    body += "\n# NOTE: the following matched files were OMITTED for size:\n- " +
      skipped.join("\n- ") + "\n";
  }
  return { prompt: body, files, skipped, bytes: used };
}
