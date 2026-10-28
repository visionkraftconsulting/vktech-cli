import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReplyCheck,
  replyFocus,
  selectTracks,
  parseMailDump,
  formatReport,
  checkReplies,
  mailcowScript,
  decodeWords,
  summaryPrompt,
  summarizeReplies,
  wantsSummary,
  SUMMARY_SYSTEM,
} from "./replies.js";

test("check replies is the status phrase, not a coding request", () => {
  assert.equal(isReplyCheck("check replies"), true);
  assert.equal(isReplyCheck("check on replies"), true);
  assert.equal(isReplyCheck("please check for replies"), true);
  assert.equal(isReplyCheck("check replies for payroll"), true);
  assert.equal(isReplyCheck("check the reply handler"), false);
  assert.equal(isReplyCheck("check replies in src/mail.js"), false);
  assert.equal(replyFocus("check replies for payroll"), "payroll");
  assert.equal(replyFocus("check on replies"), "");
});

function project(root, repoName, files) {
  const repo = realpathSync(mkdirAndReturn(join(root, repoName)));
  const memory = join(root, "projects", repo.replace(/[^A-Za-z0-9]/g, "-"), "memory");
  mkdirSync(memory, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(memory, name), body);
  return { repo, memory };
}

function mkdirAndReturn(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("each repo contributes only its own tracked threads", async () => {
  const root = mkdtempSync(join(tmpdir(), "vktech-replies-"));
  try {
    const pay = project(root, "vkPay", {
      "MEMORY.md": [
        "- [Payments RFP](payments.md) — Finix card and ACH",
        "- [Payroll outreach](payroll.md) — Everee and Check",
        "- [How to quote](hand-sent-replies.md) — standing send rule",
      ].join("\n"),
      "payments.md": [
        "---",
        "description: Finix payments",
        "---",
        "Sent from ops@vktech.ai to sales@finix.com. Watch replies in the mailbox.",
        "2026-10-06 Finix answered from partner@finix.com.",
      ].join("\n"),
      "payroll.md": [
        "Replies go to the mailbox, not the tickets.",
        "Sent 2026-10-17 from ops@vktech.ai to sales@everee.com.",
      ].join("\n"),
      "hand-sent-replies.md": [
        "Build replies with build-reply.py. Sent from sales@vktech.ai to partner@everee.com.",
        "2026-10-21 bare replies looked like a missing thread.",
      ].join("\n"),
    });
    const workforceRepo = project(root, "vkWorkforce", {
      "MEMORY.md": "- [EDI follow-up](edi.md) — PGBA enrollment",
      "edi.md": [
        "When the user says EDI, follow up and check the reply.",
        "Search from:palmettogbaservices.com newer_than:90d in Gmail.",
        "2026-10-20 Miriam replied on the enrollment thread.",
      ].join("\n"),
    });

    const payTracks = selectTracks(pay.memory).map((track) => track.fileName);
    assert.deepEqual(payTracks.sort(), ["payments.md", "payroll.md"]);

    const dump = [
      "@@BEGIN ops@vktech.ai INBOX",
      "uid: 10",
      "date.received: 2026-10-24 20:00:00 (+0000)",
      "hdr.from: Vendor Rep <partner@finix.com>",
      "hdr.to: Ops <ops@vktech.ai>",
      "hdr.subject: Production access",
      "",
      "@@END 0",
      "@@BEGIN ops@vktech.ai Sent",
      "uid: 4",
      "date.received: 2026-10-22 18:00:00 (+0000)",
      "hdr.from: Ops <ops@vktech.ai>",
      "hdr.to: sales@everee.com",
      "hdr.subject: Payroll follow up",
      "",
      "@@END 0",
    ].join("\n");

    const report = await checkReplies({
      cwd: pay.repo,
      projectsRoot: join(root, "projects"),
      now: new Date("2026-10-26T22:00:00Z"),
      run: async (script) => {
        assert.match(script, /ops@vktech.ai/);
        assert.doesNotMatch(script, /palmetto/);
        return { code: 0, out: dump, err: "" };
      },
    });
    assert.match(report, /Replies · vkPay/);
    assert.match(report, /Payment processing/);
    assert.match(report, /Production access/);
    assert.match(report, /Waiting on us/);
    assert.match(report, /Payroll/);
    assert.match(report, /Waiting on them/);
    assert.doesNotMatch(report, /palmetto|Miriam|PGBA/);
    assert.doesNotMatch(report, /How to quote|build-reply/);

    // The summary gets the same report plus this repo's notes for those threads only.
    const detailed = await checkReplies({
      cwd: pay.repo,
      projectsRoot: join(root, "projects"),
      now: new Date("2026-10-26T22:00:00Z"),
      detailed: true,
      run: async () => ({ code: 0, out: dump, err: "" }),
    });
    assert.equal(detailed.report, report);
    assert.match(detailed.notes, /^## /);
    assert.doesNotMatch(detailed.notes, /palmetto|Miriam|PGBA/);

    const workforce = await checkReplies({
      cwd: workforceRepo.repo,
      projectsRoot: join(root, "projects"),
      now: new Date("2026-10-26T22:00:00Z"),
      run: async () => {
        throw new Error("workforce notes are Gmail and must not call Mailcow");
      },
    });
    assert.match(workforce, /Replies · vkWorkforce/);
    assert.match(workforce, /VA \/ EDI/);
    assert.match(workforce, /Gmail/);
    assert.doesNotMatch(workforce, /Finix|Everee/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mail failure still prints the memory status", () => {
  const tracks = [{
    title: "Payments RFP",
    hint: "",
    fileName: "payments.md",
    group: "Payment processing",
    parties: ["finix.com"],
    labels: ["finix"],
    mailboxes: ["ops@vktech.ai"],
    channel: "mailcow",
    note: "2026-10-06 Finix answered and asked for the risk application.",
  }];
  const text = formatReport({
    project: { name: "vkPay", dir: "/tmp/vkPay" },
    tracks,
    messages: [],
    mailError: "Connection timed out",
    since: "2026-09-11",
    checkedAt: new Date("2026-10-26T22:00:00Z"),
    focus: "",
  });
  assert.match(text, /not checked/);
  assert.match(text, /Last note  2026-10-06 Finix answered/);
  assert.doesNotMatch(text, /no matching message/);
});

test("encoded mail headers are readable", () => {
  assert.equal(decodeWords("=?UTF-8?Q?Rudy_Pe=C3=B1a?="), "Rudy Peña");
  assert.equal(decodeWords("=?UTF-8?Q?US_=E2=86=92_Kenya?="), "US → Kenya");
});

test("doveadm output becomes messages and the script stays quoted", () => {
  const messages = parseMailDump([
    "uid: 2",
    "date.received: 2026-10-11 19:43:00",
    "hdr.from: Support <support@nium.com>",
    "hdr.subject: Re: partnership",
  ].join("\n"));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].subject, "Re: partnership");
  const script = mailcowScript(["ops@vktech.ai", "not a box"], "2026-09-11");
  assert.match(script, /ops@vktech.ai/);
  assert.doesNotMatch(script, /not a box/);
});

test("the summary is asked for with the report, the notes and the report rules", async () => {
  const report = "Replies · vkPay\nPayroll\n  Status     their note is newer. Waiting on us.";
  let seen;
  const fakeAsk = async (args) => {
    seen = args;
    return { provider: "local", model: "qwen3.8:27b", text: "  **Bottom line:** one thread waits on us.\n" };
  };
  const out = await summarizeReplies({ report, notes: "## Payroll\nEveree chosen 2026-10-26.", ask: fakeAsk, modelArg: "local" });
  assert.equal(out.text, "**Bottom line:** one thread waits on us.");
  assert.equal(out.provider, "local");
  assert.equal(seen.modelArg, "local");
  assert.equal(seen.system, SUMMARY_SYSTEM);
  assert.match(seen.prompt, /Waiting on us/);
  assert.match(seen.prompt, /Everee chosen 2026-10-26/);
  assert.match(SUMMARY_SYSTEM, /Bottom line/);
  assert.match(SUMMARY_SYSTEM, /Next steps \(proposals, not sent\)/);
  assert.match(summaryPrompt({ report }), /^Mail report:/);
});

test("no summary when there is nothing tracked, or when turned off", () => {
  assert.equal(wantsSummary("Replies · x\nNo tracked integration email in this repo's Claude memory."), false);
  assert.equal(wantsSummary("Replies\nNo Claude memory for /tmp/x or its parent folders."), false);
  assert.equal(wantsSummary("Replies · vkPay\nPayroll"), true);
  process.env.VKTECH_REPLIES_SUMMARY = "0";
  try {
    assert.equal(wantsSummary("Replies · vkPay\nPayroll"), false);
  } finally {
    delete process.env.VKTECH_REPLIES_SUMMARY;
  }
});
