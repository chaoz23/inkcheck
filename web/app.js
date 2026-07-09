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
const result = document.querySelector("#result");
const summary = document.querySelector("#result-summary");
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
  const limitations = [
    explore.truncated && "truncated",
    explore.randomnessDetected && "randomness detected",
    explore.externalFunctionsStubbed?.length && "EXTERNAL functions stubbed",
  ].filter(Boolean);
  const base = `${explore.statesExplored} states explored · ${explore.endingsFound.length} terminal states · ${explore.runtimeErrors.length} runtime errors · ${explore.unvisitedKnots.length} unvisited knots`;
  return limitations.length ? `${base} · limitations: ${limitations.join(", ")}` : base;
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  result.hidden = true;
  setStatus("Running a deeper hosted check…");
  try {
    const data = new FormData();
    addStoryParts(data);
    data.append("authorized", String(document.querySelector("#authorized").checked));
    data.append("privacyAcknowledged", String(document.querySelector("#privacy").checked));

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
