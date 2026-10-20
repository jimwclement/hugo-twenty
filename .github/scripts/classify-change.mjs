#!/usr/bin/env node
/**
 * Risk router for the review bot, SHARED TEMPLATE copy.
 *
 * This file is installed into every repo that runs the template bot by
 * scripts/add-review-bot.sh in jimwclement/builder-ops, from
 * .github/scripts/review-bot/ there. Edit it THERE and re-run the installer;
 * scripts/review-bot-status.sh reports any copy that no longer matches.
 * builder-ops itself runs a byte-identical copy at
 * .github/scripts/classify-change.mjs (the nightly sweep and review.mjs
 * import it from there): change both together.
 *
 * The lists below are the risk surfaces every Next.js site has, written so a
 * file nobody listed classifies UP, not down.
 *
 * Reads the files changed in a PR and decides which model and effort the
 * reviewer should use, or whether to skip the review entirely. Writes
 * skip / tier / model / effort / files to $GITHUB_OUTPUT.
 *
 * Policy:
 *  - Mixed-tier PRs take the MAXIMUM tier across every touched path.
 *  - When classification is ambiguous, classify UPWARD.
 *  - Control-plane files are never skipped, whatever their extension.
 *  - Only inert assets are skipped. Anything that can execute or render for a
 *    user gets reviewed.
 *
 * SECURITY: this script must be executed from the DEFAULT BRANCH copy, never
 * the PR's copy. A PR that can edit its own classifier can emit skip=true and
 * bypass the gate entirely. The workflow enforces this by checking out the
 * default branch and treating PR content purely as diff data.
 *
 * Usage: GITHUB_REPOSITORY=o/r PR_NUMBER=1 GITHUB_TOKEN=... \\
 *          node .github/scripts/classify-change.mjs
 */

import { appendFileSync } from "node:fs";

/* ---------------------------------------------------------------------------
 * Tier 3. If this is wrong it leaks data, sends mail it should not, breaks a
 * form a buyer depends on, changes what a public visitor is shown at the
 * moment that matters, or weakens the CI that guards all of it. A clean build
 * proves none of those, so this is the tier worth medium reasoning.
 * ------------------------------------------------------------------------- */
export const TIER3 = [
  /* EVERY server action is a write surface. Our sites name them actions.ts,
     quote-actions.ts, contact-actions.ts, jim-actions.ts: any file whose name
     ENDS in "actions", or anything under an actions/ folder. A "use server"
     file with another name falls to tier 2; the path is all a router sees. */
  /(^|\/)([^/]*[-_.])?actions\.(ts|tsx|js|mjs)$/,
  /(^|\/)actions\//,

  /* EVERY route handler, wherever it lives: a route.ts is a request entry
     point (feeds, llms.txt, CSV exports and the review-pin API alike). */
  /(^|\/)route\.(ts|tsx|js|mjs)$/,
  /^app\/api\//,

  /* Request-time chokepoints and production config. middleware runs before
     every request; instrumentation(-client) runs before hydration on every
     page (analytics, consent, bot protection); next.config carries redirects
     and headers; vercel.json schedules crons and build rules. */
  /^(src\/)?middleware\.(ts|js|mjs)$/,
  /^(src\/)?instrumentation(-client)?\.(ts|js|mjs)$/,
  /^next\.config\.(ts|js|mjs|cjs)$/,
  /^vercel\.json$/,
  /^auth\.(ts|js)$/,

  /* EVERYTHING under lib/ is tier 3 by DEFAULT: enumerating dangerous files
     one at a time failed three review rounds running where this came from, because a missed entry is silent under-review.
     Inverted, the drift is safe: a new lib/ file (mail, tokens, the review
     database) is expensive until somebody proves it is inert. Pure-copy
     lib/ files cost a few cents more here; there is no downgrade list in the
     shared copy because no file is pure copy in every repo. */
  /^(src\/)?lib\//,

  /* scripts/ by default: on sites like this one they upload media
     to production Blob storage, import content and rewrite redirects. */
  /^scripts\//,

  /* A workflow, the review scripts or the Dependabot config can disable a
     gate or exfiltrate a secret. Review it like production code, because it
     is. */
  /^\.github\//,

  /* Dependency changes are the supply-chain surface, and the moment an
     integration's architecture is chosen. Every package manager's manifest
     and lockfile, at any depth: a lockfile-only change (npm audit fix, a
     hand-resolved merge) swaps executable code as surely as a version bump
     in package.json. (review.mjs leaves the npm, pnpm and yarn lockfiles out
     of the diff it sends, so a PR changing only one of those fails red with
     "Nothing reviewable" rather than passing unread.) */
  /(^|\/)package\.json$/,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb)$/,
  /* Any *.lock: yarn, bun, deno, and Gemfile, composer, Cargo, poetry should one appear. */
  /\.lock$/,
  /(^|\/)\.(npmrc|yarnrc(\.yml)?|pnpmfile\.cjs)$/,

  /* A committed environment file is a secrets event, not a code change. */
  /(^|\/)\.env/,
];

/* Control plane. These define what the reviewer enforces, so a change here
   silently weakens every future review. Never skipped despite being markdown. */
export const CONTROL = [
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^docs\/CODE-REVIEW-STANDARD\.md$/,
  /^docs\/[^/]*RULES[^/]*\.md$/,
];

/* Tier 1 downgrades: checked FIRST, so they would beat the blanket lib/ rule.
   Deliberately empty in the shared copy (see the lib/ rule above). */
export const TIER1 = [];

/* Genuinely inert or generated. Everything else that is prose falls through to
   tier 1 rather than being skipped. Skip by inert extension, never by
   directory (public/ holds live HTML on some of our sites). */
export const SKIP = [
  /^CHANGELOG\.md$/,
  /^code-review.*\.md$/,
  /* The bots' own reports only, by their exact names: the PR review's
     pr-<n>.md and the full audit's audit-YYYY-MM-DD.md (a second audit on the
     same day is audit-YYYY-MM-DD-2.md). Not the directory: an executable
     file under docs/reviews/ is code and is reviewed. */
  /^docs\/reviews\/(pr-[0-9]+|audit-[0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]+)?)\.md$/,
  /* SVG is deliberately absent. It can carry inline script and event
     handlers, and served same-origin it runs with whatever the browser
     already has. It falls through to tier 2. */
  /* No ".lock" here: lockfiles are dependencies (tier 3 above), not assets. */
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|pdf|woff2?|ttf|eot|mp4|webm|mov|mp3|wav|zip|gz|tgz)$/i,
];

/* Prose that is not control plane. Cheap review beats no review. */
export const PROSE = [/\.md$/, /^docs\//, /^\.vscode\//, /^LICENSE$/];

/* Provider + model per tier (9 Oct 2026): one model, gpt-6.1-sol, for every
   tier; tier 3 gets medium reasoning, tiers 1 and 2 low (review.mjs). Not
   Claude, which writes the code. Google was dropped: its key kept running out
   and one vendor is one bill to keep funded. Luna is never used for review:
   the 5.6 Luna recalled 41.3% on long context, and no recall figure exists
   yet for GPT-6 Luna. `effort` is kept for the Meta line. */
const TIERS = {
  3: { provider: "openai", model: "gpt-6.1-sol", effort: "medium" },
  2: { provider: "openai", model: "gpt-6.1-sol", effort: "low" },
  1: { provider: "openai", model: "gpt-6.1-sol", effort: "low" },
};

const match = (patterns, file) => patterns.some((re) => re.test(file));

export function tierFor(file) {
  /* TIER1 is checked FIRST because it is the explicit downgrade list for the
     blanket lib/ rule in TIER3. Order matters here. */
  if (match(TIER1, file)) return 1;
  if (match(TIER3, file)) return 3;
  if (match(CONTROL, file)) return 2; // control plane beats every skip rule
  if (match(SKIP, file)) return 0;
  if (match(PROSE, file)) return 1; // reviewed cheaply, never skipped
  return 2; // ambiguous classifies upward, not down
}

/** Highest tier across the changed set. Empty set is unknown, so tier 3. */
export function classify(files) {
  if (!files || files.length === 0) return 3;
  return files.reduce((max, f) => Math.max(max, tierFor(f)), 0);
}

/**
 * Changed paths for a PR, from the GitHub API rather than git.
 *
 * Two reasons this beats shelling out to git:
 *
 *  1. No credentials. The route job checks out the trusted default branch with
 *     `persist-credentials: false`, so there is no git auth to fetch the PR head
 *     with on a private repo. An earlier version tried and failed with
 *     "could not read Username for https://github.com".
 *  2. Renames are explicit. `git diff --name-only` reports only the DESTINATION
 *     of a detected rename, so moving app/api/example/route.ts to
 *     docs/example.md looked docs-only and would have been skipped while
 *     actually deleting a production route. The API returns status "renamed"
 *     together with `previous_filename`, so BOTH sides are classified.
 *     Raised by Codex on PR #51.
 */
export async function changedFilesFromApi({ repo, pr, token, fetchImpl = fetch }) {
  /* GitHub's PR files endpoint returns at most 3,000 files (30 pages of 100).
     Silently stopping there means a PR of 3,000 harmless generated files
     followed by a Stripe change would classify on the harmless ones alone.
     If we consume the whole window we do not know what we did not see, so we
     throw and the caller fails open at tier 3. Codex, PR #51 round 2. */
  const PER_PAGE = 100;
  const MAX_PAGES = 30;
  const files = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchImpl(
      `https://api.github.com/repos/${repo}/pulls/${pr}/files?per_page=${PER_PAGE}&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "review-bot-router",
        },
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const f of batch) {
      if (f.filename) files.push(f.filename);
      /* Count the source of a rename too. The destination may look harmless. */
      if (f.previous_filename) files.push(f.previous_filename);
    }
    if (batch.length < PER_PAGE) break;
    if (page === MAX_PAGES) {
      throw new Error(
        "PR file list hit the GitHub 3,000-file cap; cannot classify the full change set",
      );
    }
  }
  return [...new Set(files)];
}

/* CLI. Skipped when imported by the test file. */
const isMain = process.argv[1] && process.argv[1].endsWith("classify-change.mjs");
if (isMain) {
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR_NUMBER;
  const token = process.env.GITHUB_TOKEN;

  let changed = [];
  let failedOpen = false;
  try {
    if (!repo || !pr || !token) {
      throw new Error("GITHUB_REPOSITORY, PR_NUMBER and GITHUB_TOKEN are required");
    }
    changed = await changedFilesFromApi({ repo, pr, token });
  } catch (err) {
    /* Fail OPEN, not closed. If we cannot tell what changed we review at the
       highest tier rather than skipping something dangerous. Costs one
       expensive run; the alternative is silence on a money change. */
    console.error(`Could not list changed files, failing open at tier 3: ${err.message}`);
    failedOpen = true;
    changed = [];
  }

  const tier = classify(changed);
  const skip = tier === 0;
  const chosen = TIERS[tier] ?? TIERS[3];

  console.log(`Changed files: ${changed.length}${failedOpen ? " (lookup failed)" : ""}`);
  for (const f of changed) console.log(`  tier ${tierFor(f)} ${f}`);
  console.log(
    skip
      ? "Result: SKIP (inert assets and generated files only)"
      : `Result: tier ${tier} -> ${chosen.provider}/${chosen.model}`,
  );

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(
      out,
      [
        `skip=${skip}`,
        `tier=${tier}`,
        `provider=${chosen.provider}`,
        `model=${chosen.model}`,
        `effort=${chosen.effort}`,
        `files=${changed.length}`,
        "",
      ].join("\n"),
    );
  }
}
