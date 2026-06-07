// Dynamic industry/domain detection for `vktech audit auto`.
// Scans a project's text (package.json, READMEs, route/page filenames, env keys, source)
// for keyword signals, scores known industries, and returns the best match along with the
// compliance frameworks and audit template that fit. No deps — plain fs walk + scoring.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

// Each industry: signal keywords (weighted by where they appear), the compliance
// frameworks to grade against, and the default template to use.
const INDUSTRIES = [
  {
    key: "healthcare",
    label: "Healthcare / Health-tech (PHI)",
    template: "hipaa-iso",
    frameworks: ["HIPAA Security Rule", "HIPAA Privacy Rule", "ISO 27001", "SOC 2", "HITECH"],
    signals: ["hipaa", "phi", "patient", "clinician", "vitals", "ehr", "emr", "baa",
      "covered entity", "telehealth", "medical", "homecare", "home-care", "caregiver",
      "icd-10", "hl7", "fhir", "visit-schedules", "nurse", "diagnos"],
  },
  {
    key: "fintech",
    label: "Fintech / Payments / Trading",
    template: "security-review",
    frameworks: ["PCI-DSS", "SOC 2", "ISO 27001", "GLBA", "SOX (if public)"],
    signals: ["stripe", "plaid", "ach", "pci", "cardholder", "payment", "payout", "ledger",
      "brokerage", "tradier", "alpaca", "trading", "kyc", "aml", "iban", "swift",
      "settlement", "invoice", "billing", "wallet", "crypto", "coinbase"],
  },
  {
    key: "ecommerce",
    label: "E-commerce / Retail",
    template: "security-review",
    frameworks: ["PCI-DSS", "SOC 2", "GDPR/CCPA (customer data)"],
    signals: ["cart", "checkout", "product", "sku", "inventory", "shopify", "order",
      "shipping", "fulfillment", "catalog", "storefront", "coupon", "wishlist"],
  },
  {
    key: "edtech",
    label: "EdTech (student data)",
    template: "prod-readiness",
    frameworks: ["FERPA", "COPPA (if under-13)", "SOC 2", "GDPR/CCPA"],
    signals: ["student", "course", "lesson", "grade", "ferpa", "coppa", "classroom",
      "enrollment", "curriculum", "lms", "quiz", "assignment", "teacher", "school"],
  },
  {
    key: "hr-staffing",
    label: "HR / Staffing / Workforce",
    template: "hipaa-iso",
    frameworks: ["FCRA (background checks)", "EEOC", "SOC 2", "ISO 27001", "GDPR/CCPA (PII)"],
    signals: ["applicant", "candidate", "recruit", "onboarding", "payroll", "timesheet",
      "shift", "background check", "fcra", "employee", "staffing", "workforce", "i-9",
      "w-2", "ats", "hris"],
  },
  {
    key: "saas-generic",
    label: "General B2B SaaS",
    template: "prod-readiness",
    frameworks: ["SOC 2", "ISO 27001", "GDPR/CCPA (if EU/CA users)"],
    signals: ["tenant", "subscription", "saas", "dashboard", "webhook", "api key",
      "multi-tenant", "organization", "workspace", "billing", "usage"],
  },
  {
    key: "govtech",
    label: "Government / Public sector",
    template: "security-review",
    frameworks: ["FedRAMP", "NIST 800-53", "FISMA", "CJIS (if law-enforcement)"],
    signals: ["fedramp", "nist", "fisma", "cjis", "gov", ".gov", "public sector",
      "citizen", "agency", "compliance authority"],
  },
];

const TEXT_EXT = new Set([".js", ".ts", ".tsx", ".jsx", ".json", ".md", ".env", ".example",
  ".txt", ".yml", ".yaml", ".prisma", ".sql"]);

// Walk a dir collecting a capped sample of text content + all relative paths.
// Filenames are strong signals (route/page dirs like /privacy, /visits, /checkout).
function collect(dir, { maxFiles = 400, maxBytesPerFile = 40_000 } = {}) {
  const paths = [];
  let text = "";
  let count = 0;
  const skip = new Set(["node_modules", ".git", "dist", ".next", "build", ".turbo", "coverage"]);
  const stack = [dir];
  while (stack.length && count < maxFiles) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) stack.push(full);
        paths.push(relative(dir, full).split("\\").join("/") + "/");
      } else {
        const rel = relative(dir, full).split("\\").join("/");
        paths.push(rel);
        const dot = e.name.lastIndexOf(".");
        const ext = dot >= 0 ? e.name.slice(dot) : "";
        // Always read high-signal small files; sample source otherwise.
        const highValue = /package\.json$|readme|\.env|description|manifest/i.test(e.name);
        if (count < maxFiles && (highValue || TEXT_EXT.has(ext))) {
          try {
            if (statSync(full).size <= maxBytesPerFile) {
              text += "\n" + readFileSync(full, "utf8");
              count++;
            }
          } catch { /* ignore */ }
        }
      }
    }
  }
  return { text: text.toLowerCase(), paths: paths.map((p) => p.toLowerCase()) };
}

// Score each industry. Content hits = 1 pt, path/filename hits = 3 pts (structural signal).
export function detectIndustry(dir, opts = {}) {
  const { text, paths } = collect(dir, opts);
  const pathBlob = paths.join("\n");
  const scored = INDUSTRIES.map((ind) => {
    let score = 0;
    const hits = [];
    for (const sig of ind.signals) {
      const inContent = text.includes(sig);
      const inPaths = pathBlob.includes(sig);
      if (inContent) score += 1;
      if (inPaths) score += 3;
      if (inContent || inPaths) hits.push(sig);
    }
    return { ...ind, score, hits };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  const runnerUp = scored[1];
  // Confidence: clear winner if top has a real lead.
  const confident = top.score >= 3 && top.score >= (runnerUp?.score ?? 0) + 2;
  return {
    industry: confident ? top : { ...scored.find((s) => s.key === "saas-generic"), fallback: true, topGuess: top },
    confident,
    ranking: scored.filter((s) => s.score > 0).slice(0, 4),
  };
}

export { INDUSTRIES };
