import test from "node:test";
import assert from "node:assert/strict";
import { isRepliesReport, renderReplies, renderTurn, renderMarkdown } from "./render.js";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const REPORT = [
  "Replies · demoRepo",
  "Memory  /tmp/demoRepo",
  "Mail    mail.example.test · Oct 27, 9:26 AM PT · since 2026-09-12",
  "Each repo uses its own Claude memory. Other projects are not included.",
  "",
  "Payment processing",
  "  Demo payments RFP",
  "  Watching   ops@example.test",
  "  Parties    example.com",
  "  Oct 26, 5:26 PM    in   Example Sales",
  "                          Re: pricing",
  "  Status     their note is newer. Waiting on us.",
  "  Last note  Sent the form on `2026-10-26`.",
  "",
  "Payroll",
  "  Demo payroll RFP",
  "  Status     our note is newer. Waiting on them.",
  "  Mail       not checked.",
].join("\n");

test("a replies report is recognised by its title line", () => {
  assert.equal(isRepliesReport(REPORT), true);
  assert.equal(isRepliesReport("Replies\nNo Claude memory for /tmp."), true);
  assert.equal(isRepliesReport("**Replies** are pending"), false);
});

test("replies report is plain without colour and keeps its text when coloured", () => {
  assert.equal(renderReplies(REPORT, { color: false }), REPORT);
  const painted = renderReplies(REPORT, { color: true });
  assert.notEqual(painted, REPORT);
  assert.match(painted, /\x1b\[/);
  // Status rows gain a mark (! on us, ✓ on them, ✗ not checked) and stay aligned.
  const lines = strip(painted).split("\n");
  assert.equal(lines.find((l) => l.includes("Waiting on us")), "  ! Status   their note is newer. Waiting on us.");
  assert.equal(lines.find((l) => l.includes("Waiting on them")), "  ✓ Status   our note is newer. Waiting on them.");
  assert.equal(lines.find((l) => l.includes("not checked")), "  ✗ Mail     not checked.");
  assert.equal(lines.find((l) => l.includes("Example Sales")), "  Oct 26, 5:26 PM    in   Example Sales");
  assert.equal(lines.find((l) => l.includes("Last note")), "  Last note  Sent the form on 2026-10-26.");
});

test("a replayed turn uses the live layout, not you/model labels", () => {
  const user = renderTurn({ role: "user", text: "status" }, { model: "m:1", color: false });
  assert.equal(user, "❯ status");
  const reply = renderTurn({ role: "assistant", text: "**All good.**" }, { model: "m:1", color: false });
  assert.equal(reply, "\n[local:m:1]\n\n**All good.**");
  const via = renderTurn({ role: "assistant", text: "hi", via: "xai:grok" }, { color: false });
  assert.match(via, /^\n\[xai:grok\]\n/);
  const replies = renderTurn({ role: "assistant", text: REPORT }, { model: "m:1", color: true });
  assert.match(strip(replies), /^\n\[replies:mailcow\]\n\n/);
  assert.match(replies, /\x1b\[/);
  assert.ok(!/^you$/m.test(strip(user + reply)));
});

test("replayed Markdown matches the live renderer", () => {
  const md = "**Open / next**\n- waiting on the vendor\n- deployed";
  const turn = renderTurn({ role: "assistant", text: md }, { model: "m", color: true });
  assert.ok(turn.endsWith(renderMarkdown(md, { color: true })));
});
