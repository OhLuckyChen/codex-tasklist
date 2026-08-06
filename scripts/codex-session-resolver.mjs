import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_TIME_SKEW_MS = 60_000;

async function listSessionFiles(directory, files = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    const entryPath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await listSessionFiles(entryPath, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
  }));
  return files;
}

async function readMatchingSession(filePath, marker) {
  let threadId = "";
  let matched = false;
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!matched && line.includes(marker)) matched = true;
    if (!threadId && line.includes('"type":"session_meta"')) {
      try {
        const record = JSON.parse(line);
        const candidate = String(record?.payload?.session_id || record?.payload?.id || "").toLowerCase();
        if (THREAD_ID_PATTERN.test(candidate)) threadId = candidate;
      } catch {}
    }
    if (matched && threadId) break;
  }
  lines.close();
  return matched && threadId ? threadId : "";
}

export async function resolveCodexSessionByMarker({ sessionsRoot, marker, startedAt }) {
  if (typeof sessionsRoot !== "string" || !sessionsRoot) throw new Error("sessionsRoot is required");
  if (typeof marker !== "string" || marker.length < 8 || marker.length > 200) {
    throw new Error("marker must contain 8-200 characters");
  }
  if (!Number.isFinite(startedAt) || startedAt <= 0) throw new Error("startedAt is invalid");

  const firstDate = new Date(startedAt - FILE_TIME_SKEW_MS);
  firstDate.setHours(0, 0, 0, 0);
  const lastDate = new Date();
  lastDate.setHours(0, 0, 0, 0);
  const dateDirectories = [];
  for (const date = firstDate; date <= lastDate; date.setDate(date.getDate() + 1)) {
    dateDirectories.push(pathForDate(sessionsRoot, date));
  }
  const files = (await Promise.all(dateDirectories.map((directory) => listSessionFiles(directory))))
    .flat();
  const recentFiles = [];
  for (const filePath of files) {
    try {
      const metadata = await stat(filePath);
      if (metadata.mtimeMs >= startedAt - FILE_TIME_SKEW_MS) recentFiles.push(filePath);
    } catch {}
  }
  const matches = (await Promise.all(
    recentFiles.map((filePath) => readMatchingSession(filePath, marker)),
  )).filter(Boolean);
  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length > 1) throw new Error("Multiple Codex sessions matched one taskboard request");
  return uniqueMatches[0] || null;
}

function pathForDate(sessionsRoot, date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${sessionsRoot}/${year}/${month}/${day}`;
}
