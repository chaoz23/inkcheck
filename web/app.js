const form = document.querySelector("#check-form");
const mainFileInput = document.querySelector("#main-file");
const includeFilesInput = document.querySelector("#include-files");
const folderInput = document.querySelector("#folder");
const storyText = document.querySelector("#story-text");
const rootChoice = document.querySelector("#root-choice");
const rootSelect = document.querySelector("#root");
const selectionNote = document.querySelector("#selection-note");
const submit = document.querySelector("#submit");
const status = document.querySelector("#form-status");
const authorized = document.querySelector("#authorized");
const privacy = document.querySelector("#privacy");
const result = document.querySelector("#result");
const summary = document.querySelector("#result-summary");
const findings = document.querySelector("#result-findings");
const resultJson = document.querySelector("#result-json");
const download = document.querySelector("#download");
let lastResponse = null;

function folderEntries() {
  const entries = Array.from(folderInput.files)
    .filter((file) => file.name.toLowerCase().endsWith(".ink"))
    .map((file) => ({ file, name: file.webkitRelativePath || file.name }));
  if (entries.length && entries.every((entry) => entry.name.includes("/"))) {
    const first = entries[0].name.split("/")[0];
    if (entries.every((entry) => entry.name.startsWith(`${first}/`))) {
      for (const entry of entries) entry.name = entry.name.slice(first.length + 1);
    }
  }
  return entries;
}

function individualEntries() {
  const entries = [];
  const main = mainFileInput.files[0];
  if (main?.name.toLowerCase().endsWith(".ink")) entries.push({ file: main, name: main.name });
  for (const file of includeFilesInput.files) {
    if (file.name.toLowerCase().endsWith(".ink")) entries.push({ file, name: file.name });
  }
  return entries;
}

function refreshSelection() {
  const folder = folderEntries();
  rootSelect.replaceChildren();
  if (folder.length) {
    for (const entry of folder) rootSelect.add(new Option(entry.name, entry.name));
    const likelyRoot = folder.find((entry) => /(^|\/)(main|story)\.ink$/i.test(entry.name));
    if (likelyRoot) rootSelect.value = likelyRoot.name;
    rootChoice.hidden = false;
    selectionNote.textContent = `${folder.length} unchanged .ink file${folder.length === 1 ? "" : "s"} selected from the project folder.`;
    return;
  }

  rootChoice.hidden = true;
  const main = mainFileInput.files[0];
  if (main) {
    rootSelect.add(new Option(main.name, main.name));
    const extras = Array.from(includeFilesInput.files).filter((file) => file.name.toLowerCase().endsWith(".ink"));
    selectionNote.textContent = `${main.name} selected as the main file${extras.length ? ` with ${extras.length} INCLUDE file${extras.length === 1 ? "" : "s"}` : ""}.`;
  } else {
    rootSelect.add(new Option("main.ink", "main.ink"));
    selectionNote.textContent = storyText.value.trim()
      ? "Pasted contents will be checked as main.ink."
      : "Choose one main file or paste its contents.";
  }
}

mainFileInput.addEventListener("change", () => {
  if (mainFileInput.files.length) folderInput.value = "";
  refreshSelection();
});
includeFilesInput.addEventListener("change", () => {
  if (includeFilesInput.files.length) folderInput.value = "";
  refreshSelection();
});
folderInput.addEventListener("change", () => {
  if (folderInput.files.length) {
    mainFileInput.value = "";
    includeFilesInput.value = "";
  }
  refreshSelection();
});
storyText.addEventListener("input", refreshSelection);

function reportSummary(report) {
  const compile = report?.compile;
  const explore = report?.explore;
  if (!compile?.success) return `Compilation failed with ${compile?.errors ?? "unknown"} error(s).`;
  if (!explore) return "Compilation succeeded, but no exploration report was returned.";
  const countPhrase = (count, singular, plural = `${singular}s`) => {
    const value = Number(count) || 0;
    return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
  };
  if (explore.truncated) {
    return `Inkcheck ran and found ${countPhrase(explore.endingsFound.length, "ending")}, ${countPhrase(explore.runtimeErrors.length, "runtime error")}, and ${countPhrase(explore.unvisitedKnots.length, "unvisited knot")} in a ${countPhrase(report.stats?.words, "word")} story with ${countPhrase(report.stats?.choices, "choice")}. It may not have seen every reachable path.`;
  }
  const limitations = [
    explore.randomnessDetected && "randomness detected",
    explore.externalFunctionsStubbed?.length && "EXTERNAL functions stubbed",
  ].filter(Boolean);
  const base = `${countPhrase(report.stats?.words, "word")} · ${countPhrase(report.stats?.choices, "choice")} · ${countPhrase(explore.statesExplored, "state")} explored · ${countPhrase(explore.endingsFound.length, "terminal state")} · ${countPhrase(explore.runtimeErrors.length, "runtime error")} · ${countPhrase(explore.unvisitedKnots.length, "unvisited knot")}`;
  return limitations.length ? `${base} · limitations: ${limitations.join(", ")}` : base;
}

const SEVERITY_LABELS = {
  error: "Errors to fix first",
  warning: "Warnings to review",
  note: "Coverage notes",
};

function locationText(item) {
  if (!item.file) return "";
  return `${item.file}${item.line ? ` line ${item.line}` : ""}${item.approximateLocation ? " (approx.)" : ""}`;
}

function fallbackHumanFindings(report) {
  const out = [];
  const compile = report?.compile || {};
  for (const issue of compile.issues || []) {
    const severity = issue.severity === "ERROR" || issue.severity === "RUNTIME ERROR"
      ? "error"
      : issue.severity === "WARNING"
        ? "warning"
        : "note";
    out.push({
      severity,
      category: issue.severity === "ERROR" ? "Compiler error" : issue.severity === "WARNING" ? "Compiler warning" : "Compiler note",
      title: issue.message || issue.raw || "Compiler finding",
      message: issue.message || issue.raw || "Compiler returned a finding without details.",
      file: issue.file,
      line: issue.line,
      action: severity === "error"
        ? "Fix this source line first; Inkcheck cannot explore the story until it compiles."
        : "Review this compiler note and decide whether the story should change.",
    });
  }
  const explore = report?.explore || {};
  for (const error of explore.runtimeErrors || []) {
    out.push({
      severity: "error",
      category: "Runtime error",
      title: (error.message || "Runtime error").replace(/\s*\(at [^)]+\)\s*$/, ""),
      message: error.message || "Ink hit a runtime error on this path.",
      file: error.sourceLocation?.file,
      line: error.sourceLocation?.line,
      approximateLocation: error.sourceLocation?.approximate,
      path: error.path,
      action: "Follow the choice path, then inspect the source near this location for a bad divert, variable, expression, or runtime-only edge case.",
    });
  }
  for (const knot of explore.unvisitedKnots || []) {
    out.push({
      severity: "warning",
      category: "Unvisited content",
      title: `No explored path reached ${knot.name}`,
      message: `The knot ${knot.name} was not visited by any explored path.`,
      file: knot.file,
      line: knot.line,
      action: "If this scene should be reachable, add or repair a divert/choice that leads here. If it is intentionally unused, mark it for yourself or remove it.",
    });
  }
  if (explore.truncated) {
    const limits = explore.limits || {};
    out.push({
      severity: "warning",
      category: "Coverage note",
      title: "Inkcheck found useful results before stopping its hosted pass",
      message: limits.maxDepth || limits.maxStates
        ? `This hosted run explored until max depth ${limits.maxDepth || "?"} or max states ${limits.maxStates || "?"}, so there may be more paths beyond this report.`
        : "This hosted run explored until its configured coverage boundary, so there may be more paths beyond this report.",
      action: "Use the findings above as real review leads. If you need a deeper hosted pass, file an issue and we can tune the service.",
    });
  }
  return out;
}

function renderFindings(items) {
  findings.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "clear";
    empty.textContent = "No compiler errors, runtime errors, or unreachable knots were found in this check.";
    findings.append(empty);
    return;
  }
  for (const severity of ["error", "warning", "note"]) {
    const group = items.filter((item) => item.severity === severity);
    if (!group.length) continue;
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    const list = document.createElement("ol");
    heading.textContent = SEVERITY_LABELS[severity];
    for (const item of group) {
      const row = document.createElement("li");
      const title = document.createElement("strong");
      const meta = document.createElement("p");
      const message = document.createElement("p");
      title.textContent = item.title || item.message || "Finding";
      meta.className = "finding-meta";
      meta.textContent = [
        item.category,
        locationText(item),
      ].filter(Boolean).join(" · ");
      message.textContent = item.message || "";
      row.append(title, meta, message);
      if (item.path?.length) {
        const path = document.createElement("p");
        path.className = "finding-path";
        path.textContent = `Choice path: ${item.path.join(" → ")}`;
        row.append(path);
      }
      if (item.action) {
        const action = document.createElement("p");
        action.className = "finding-action";
        action.textContent = `Next step: ${item.action}`;
        row.append(action);
      }
      list.append(row);
    }
    section.append(heading, list);
    findings.append(section);
  }
}

function addStoryParts(data) {
  const folder = folderEntries();
  const entries = folder.length ? folder : individualEntries();
  const names = new Set();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`Two selected files have the same path: ${entry.name}`);
    names.add(entry.name);
    data.append(`ink:${entry.name}`, entry.file, entry.file.name);
  }

  if (!folder.length && !mainFileInput.files.length) {
    if (!storyText.value.trim()) throw new Error("Choose the main .ink file or paste its contents first.");
    data.append("ink:main.ink", new Blob([storyText.value], { type: "text/plain" }), "main.ink");
    names.add("main.ink");
  }

  const root = folder.length ? rootSelect.value : mainFileInput.files[0]?.name || "main.ink";
  if (!names.has(root)) throw new Error("Choose the file that starts the story.");
  data.append("root", root);
}

function readinessMessage() {
  if (folderInput.files.length && !folderEntries().length) {
    return "The selected folder did not include any .ink files. Choose your project folder, choose the main .ink file, or paste the story contents.";
  }
  if (mainFileInput.files.length && !mainFileInput.files[0].name.toLowerCase().endsWith(".ink")) {
    return "Choose a main file ending in .ink, or paste the story contents.";
  }
  if (!folderEntries().length && !mainFileInput.files.length && !storyText.value.trim()) {
    return "Choose the main .ink file or paste its contents first.";
  }
  if (!authorized.checked && !privacy.checked) {
    return "Check the two confirmation boxes, then run Inkcheck.";
  }
  if (!authorized.checked) {
    return "Check the authorization box, then run Inkcheck.";
  }
  if (!privacy.checked) {
    return "Check the temporary-upload box, then run Inkcheck.";
  }
  return "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = readinessMessage();
  if (message) {
    setStatus(message);
    form.reportValidity();
    return;
  }
  submit.disabled = true;
  result.hidden = true;
  setStatus("Running a deeper hosted check…");
  try {
    const data = new FormData();
    addStoryParts(data);
    data.append("authorized", String(authorized.checked));
    data.append("privacyAcknowledged", String(privacy.checked));

    const headers = {};
    const accessCode = document.querySelector("#access-code").value;
    if (accessCode) headers["X-Inkcheck-Access-Code"] = accessCode;
    const response = await fetch("/api/check", { method: "POST", headers, body: data });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.error || `Request failed (${response.status})`);
      error.issueUrl = body.issueUrl;
      throw error;
    }
    lastResponse = body;
    summary.textContent = `${reportSummary(body.report)} · processed in ${body.meta.durationMs} ms · files deleted after the response.`;
    renderFindings(Array.isArray(body.humanFindings) ? body.humanFindings : fallbackHumanFindings(body.report));
    resultJson.textContent = JSON.stringify(body.report, null, 2);
    result.hidden = false;
    result.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus("Check complete.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), error.issueUrl);
  } finally {
    submit.disabled = false;
  }
});

function setStatus(message, issueUrl) {
  status.replaceChildren(document.createTextNode(message));
  if (issueUrl) {
    status.append(" ");
    const link = document.createElement("a");
    link.href = issueUrl;
    link.textContent = "File an issue";
    status.append(link, ".");
  }
}

download.addEventListener("click", () => {
  if (!lastResponse) return;
  const blob = new Blob([JSON.stringify(lastResponse.report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "inkcheck-report.json";
  link.click();
  URL.revokeObjectURL(url);
});
