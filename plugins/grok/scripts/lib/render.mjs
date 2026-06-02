// Human-readable renderers for command output (used when --json is absent).

function elapsed(job) {
  const start = Date.parse(job.startedAt ?? job.createdAt ?? "");
  const end = Date.parse(job.completedAt ?? "") || Date.now();
  if (Number.isNaN(start)) return "—";
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export function renderConsultResult(result) {
  if (result.ok) {
    return result.text.trimEnd() + "\n";
  }
  const lines = ["[grok] Consultation did not complete."];
  if (result.errorMessage) lines.push(result.errorMessage);
  if (result.stopReason) lines.push(`stopReason: ${result.stopReason}`);
  if (result.text) lines.push("", "Partial output:", result.text.trim());
  return lines.join("\n") + "\n";
}

export function renderReviewResult(result, { targetLabel } = {}) {
  if (result.ok) {
    const head = targetLabel ? `Grok review — ${targetLabel}\n\n` : "";
    return head + result.text.trimEnd() + "\n";
  }
  const lines = ["[grok] Review did not complete."];
  if (result.errorMessage) lines.push(result.errorMessage);
  if (result.stopReason) lines.push(`stopReason: ${result.stopReason}`);
  if (result.text) lines.push("", "Partial output:", result.text.trim());
  return lines.join("\n") + "\n";
}

export function renderQueuedLaunch(job) {
  return `${job.title} started in the background as ${job.id}. Check \`/grok:status ${job.id}\` for progress.\n`;
}

export function renderStatusTable(jobs) {
  if (jobs.length === 0) return "No Grok jobs for this workspace.\n";
  const rows = jobs.map((j) => ({
    id: j.id,
    kind: j.kindLabel ?? j.kind ?? "—",
    status: j.status ?? "—",
    phase: j.phase ?? "—",
    elapsed: elapsed(j),
    summary: (j.summary ?? "").replace(/\s+/g, " ").slice(0, 60),
  }));
  const header = "| Job | Kind | Status | Phase | Elapsed | Summary |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map(
    (r) => `| ${r.id} | ${r.kind} | ${r.status} | ${r.phase} | ${r.elapsed} | ${r.summary} |`,
  );
  return [header, sep, ...body].join("\n") + "\n";
}

export function renderJobStatus(job) {
  const lines = [
    `Job:     ${job.id}`,
    `Kind:    ${job.kindLabel ?? job.kind}`,
    `Status:  ${job.status}${job.phase ? ` (${job.phase})` : ""}`,
    `Elapsed: ${elapsed(job)}`,
  ];
  if (job.summary) lines.push(`Summary: ${job.summary}`);
  if (job.stopReason) lines.push(`stopReason: ${job.stopReason}`);
  if (job.errorMessage) lines.push(`Error:   ${job.errorMessage}`);
  if (job.status === "completed") lines.push(`\nRun \`/grok:result ${job.id}\` for the full output.`);
  if (job.status === "running") lines.push(`\nRun \`/grok:cancel ${job.id}\` to stop it.`);
  return lines.join("\n") + "\n";
}

export function renderStoredResult(job) {
  if (!job) return "Job not found.\n";
  if (job.status !== "completed" && job.status !== "failed") {
    return `Job ${job.id} is ${job.status} — no final output yet. Check \`/grok:status ${job.id}\`.\n`;
  }
  if (job.rendered) return job.rendered;
  if (job.errorMessage) return `[grok] ${job.title} failed: ${job.errorMessage}\n`;
  return "No stored output.\n";
}

export function renderCancel(job) {
  return `Cancelled ${job.id} (${job.title}).\n`;
}

export function renderSetup(report) {
  const lines = ["Grok companion setup:"];
  lines.push(`  grok CLI: ${report.grok.available ? `✓ ${report.grok.version}` : "✗ not found"}`);
  lines.push(`  auth:     ${report.auth.loggedIn ? "✓ logged in" : "✗ not logged in"}`);
  lines.push(`  ready:    ${report.ready ? "✓" : "✗"}`);
  if (report.nextSteps.length) {
    lines.push("", "Next steps:");
    for (const step of report.nextSteps) lines.push(`  - ${step}`);
  }
  return lines.join("\n") + "\n";
}
