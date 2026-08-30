import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { formatClock } from "./runs-view-model";
import type { WorkspaceFile, WorkspaceHistoryEntry, WorkspaceListing } from "./types";
import {
  checkNewFilePath,
  describeHistoryEntry,
  flattenWorkspaceTree,
  formatBytes,
  listedFileExists,
  parentPath,
  workspaceSummaryLine,
  type WorkspaceRow,
} from "./workspace-view-model";

interface Props {
  agentId: string;
  workspacePath: string;
  fileCount?: number | undefined;
  lastModified?: string | undefined;
  /** #66: while a Run has the workspace mounted the backend refuses edits with 409; the buttons
   * are disabled with the same hint so the refusal is never a surprise. */
  busy: boolean;
  history?: WorkspaceHistoryEntry[] | undefined;
  /** Fired after any successful edit so the shell can refresh the Agent (history) and workspace counts. */
  onChanged?: (() => void) | undefined;
}

const BUSY_HINT = "Run in progress — the workspace is mounted in the sandbox";
/** Client-side mirror of the server's batch caps (#66); the server re-enforces and reports both. */
const MAX_UPLOAD_FILES = 20;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const RECENT_CHANGES_SHOWN = 10;

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked: String.fromCharCode(...bytes) overflows the call stack on multi-MB files.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// #65 read-only browser + #66 editing. Listings are fetched lazily per directory through api.ts;
// all writes go through the four #66 endpoints and the backend stays the authority on every
// refusal (managed files, caps, credential scan, busy Agent). The tree follows the trace tree's
// keyboard contract: arrows move/expand, Enter previews, Escape steps back.
export default function WorkspacePanel({ agentId, workspacePath, fileCount, lastModified, busy, history, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [listings, setListings] = useState<Map<string, WorkspaceListing>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [focusReq, setFocusReq] = useState(0);
  const [preview, setPreview] = useState<WorkspaceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editText, setEditText] = useState<string | null>(null);
  const [newFilePath, setNewFilePath] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  // #350: refresh()'s preview re-fetch races the Edit button — the resolution callback needs the
  // editText value at *resolution* time (its closure only sees the value at call time), so mirror it.
  const editingRef = useRef(false);
  editingRef.current = editText !== null;
  const loading = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);

  const loadListing = async (path: string): Promise<void> => {
    if (loading.current.has(path)) return;
    loading.current.add(path);
    try {
      const listing = await api.browseWorkspace(agentId, path);
      setListings((previous) => new Map(previous).set(path, listing));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      // #341: collapse the dir again so the "loading…" placeholder doesn't persist forever
      if (path !== "") setExpanded((previous) => { const next = new Set(previous); next.delete(path); return next; });
    } finally {
      loading.current.delete(path);
    }
  };

  // Agent switch: drop everything from the previous workspace and close the panel.
  useEffect(() => {
    setOpen(false);
    setListings(new Map());
    setExpanded(new Set());
    setFocusPath(null);
    setPreview(null);
    setError(null);
    setEditText(null);
    setNewFilePath(null);
  }, [agentId]);

  useEffect(() => {
    if (open && !listings.has("")) void loadListing("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentId]);

  useEffect(() => {
    if (focusPath !== null) rowRefs.current.get(focusPath)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq]);

  // #341: clear the "Copied ✓" revert timer on unmount.
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const copyPath = () => {
    navigator.clipboard.writeText(workspacePath).then(
      () => setCopyState("copied"),
      () => setCopyState("failed"),
    );
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState(null), 1500);
  };

  /** #341: every path that would drop a dirty editor (close, open another file, Escape, Refresh)
   * confirms first. True = safe to proceed. */
  const confirmDiscardEdits = (): boolean =>
    editText === null ||
    preview === null ||
    editText === preview.content ||
    window.confirm("Discard unsaved changes to " + preview.path + "?");

  const rows = flattenWorkspaceTree(listings, expanded);
  const focusRow = (path: string) => { setFocusPath(path); setFocusReq((n) => n + 1); };
  const toggleDir = (row: WorkspaceRow) => {
    if (row.kind !== "dir") return;
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(row.path)) next.delete(row.path);
      else next.add(row.path);
      return next;
    });
    if (!row.expanded && !row.loaded) void loadListing(row.path);
  };

  const openPreview = async (path: string) => {
    try {
      setPreview(await api.readWorkspaceFile(agentId, path));
      setEditText(null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const closePreview = () => {
    if (!confirmDiscardEdits()) return;
    const back = preview?.path;
    setPreview(null);
    setEditText(null);
    if (back) focusRow(back);
  };

  const refresh = () => {
    // #344: keep a non-dirty preview open across a refresh by re-fetching it (a dirty one is only
    // reached here after confirmDiscardEdits, and stays dropped). Gone-on-refetch closes silently.
    const keep = preview !== null && (editText === null || editText === preview.content) ? preview.path : null;
    if (keep) {
      // #350: if Edit was clicked while this fetch was in flight, the editor is based on the
      // preview at click time — swapping (or closing) the preview underneath it would let Save
      // clobber the newer content, so skip; the dirty-editor guard covers the rest.
      api.readWorkspaceFile(agentId, keep).then(
        (file) => setPreview((current) => (current?.path === keep && !editingRef.current ? file : current)),
        () => setPreview((current) => (current?.path === keep && !editingRef.current ? null : current)),
      );
    } else {
      setPreview(null);
    }
    setEditText(null);
    void loadListing("");
    for (const path of expanded) if (listings.has(path)) void loadListing(path);
  };

  /** Wrap a write: report its failure in the shared banner, then refresh listings and the shell. */
  const runEdit = async (edit: () => Promise<void>): Promise<boolean> => {
    setPending(true);
    try {
      await edit();
      setError(null);
      refresh();
      onChanged?.();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setPending(false);
    }
  };

  const addFiles = async (selected: FileList) => {
    if (!confirmDiscardEdits()) return; // #341: runEdit's refresh drops a dirty editor
    const files = [...selected];
    if (files.length === 0) return;
    if (files.length > MAX_UPLOAD_FILES) {
      setError(files.length + " files selected — the limit is " + MAX_UPLOAD_FILES + " per batch");
      return;
    }
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_UPLOAD_BYTES) {
      setError("Selection is " + formatBytes(total) + " — the limit is " + formatBytes(MAX_UPLOAD_BYTES) + " per batch");
      return;
    }
    const payload = await Promise.all(
      files.map(async (file) => ({
        path: file.name,
        content: bytesToBase64(await file.arrayBuffer()),
        encoding: "base64" as const,
      })),
    );
    await runEdit(async () => { await api.seedWorkspaceFiles(agentId, payload); });
  };

  const createFile = async () => {
    if (!confirmDiscardEdits()) return; // #341: runEdit's refresh drops a dirty editor
    const checked = checkNewFilePath(newFilePath ?? "");
    if ("error" in checked) { setError(checked.error); return; }
    // UAT: "New file" over an existing path silently truncated it to 0 bytes — refuse instead.
    // #368: consult the already-loaded tree listing first — the network probe logs a visible
    // console 404 on every successful create. Listing loaded and name absent → skip the probe
    // (an outside writer racing the create could still be overwritten; acceptable, the server
    // is single-user). Listing can't answer (unloaded nested dir, truncated) → keep the probe,
    // whose 404 noise is rare on that path.
    const exists = listedFileExists(listings, checked.path)
      ?? await api.readWorkspaceFile(agentId, checked.path).then(() => true, () => false);
    if (exists) { setError(checked.path + " already exists — select it in the tree to edit it."); return; }
    const created = await runEdit(async () => {
      await api.writeWorkspaceFile(agentId, { path: checked.path, content: "", encoding: "utf8" });
    });
    if (created) {
      setNewFilePath(null);
      await openPreview(checked.path);
      setEditText("");
    }
  };

  const saveEdit = async () => {
    if (!preview || editText === null) return;
    const path = preview.path;
    const saved = await runEdit(async () => {
      await api.writeWorkspaceFile(agentId, { path, content: editText, encoding: "utf8" });
    });
    if (saved) await openPreview(path);
  };

  const deleteFile = async () => {
    if (!preview) return;
    if (!window.confirm("Delete " + preview.path + " from the workspace?")) return;
    const path = preview.path;
    const deleted = await runEdit(async () => { await api.deleteWorkspaceFile(agentId, path); });
    if (deleted) closePreview();
  };

  const resetWorkspace = async () => {
    // #341: the first dialog is the only gate on the wipe — Cancel there aborts everything. The
    // thread question is asked only after the reset is confirmed, as an additive choice whose
    // Cancel takes the safe default (conversation kept); it never widens the destruction.
    if (!window.confirm("Reset this workspace? All files are archived to .deleted/ and the platform files are recreated.")) return;
    const forgetThread = window.confirm("Reset confirmed. Also forget the Codex conversation thread, so the next run starts fresh? Cancel keeps the conversation.");
    const wiped = await runEdit(async () => { await api.resetWorkspace(agentId, forgetThread); });
    if (wiped) {
      setListings(new Map());
      setExpanded(new Set());
      setPreview(null);
      void loadListing("");
    }
  };

  const activate = (row: WorkspaceRow) => {
    if (row.kind === "dir") toggleDir(row);
    else if (confirmDiscardEdits()) void openPreview(row.path);
  };

  const onRowKey = (event: React.KeyboardEvent, index: number) => {
    const row = rows[index];
    if (!row) return;
    switch (event.key) {
      case "ArrowDown": { const next = rows[index + 1]; if (next) focusRow(next.path); break; }
      case "ArrowUp": { const previous = rows[index - 1]; if (previous) focusRow(previous.path); break; }
      case "Home": { const first = rows[0]; if (first) focusRow(first.path); break; }
      case "End": { const last = rows[rows.length - 1]; if (last) focusRow(last.path); break; }
      case "ArrowRight":
        if (row.kind !== "dir") break;
        if (!row.expanded) toggleDir(row);
        else { const child = rows[index + 1]; if (child && parentPath(child.path) === row.path) focusRow(child.path); }
        break;
      case "ArrowLeft":
        if (row.kind === "dir" && row.expanded) toggleDir(row);
        else { const parent = parentPath(row.path); if (parent && rows.some((r) => r.path === parent)) focusRow(parent); }
        break;
      case "Enter": case " ": activate(row); break;
      case "Escape":
        if (preview) closePreview();
        else setOpen(false);
        break;
      default: return;
    }
    event.preventDefault();
  };

  const rootListing = listings.get("");
  const truncated = rows.length > 0 && [...listings.values()].some((listing) => listing.truncated);
  const summary = workspaceSummaryLine(fileCount, lastModified);
  const editLocked = busy || pending;
  const editHint = busy ? BUSY_HINT : undefined;
  const canEditPreview = preview !== null && !preview.managed && preview.encoding === "utf8" && preview.content !== undefined;
  const recentChanges = (history ?? []).slice(0, RECENT_CHANGES_SHOWN);

  return (
    <section className="workspace-panel" aria-labelledby="workspace-panel-heading">
      <div className="workspace-panel-head">
        <div>
          <span className="eyebrow">Workspace</span>
          <h2 id="workspace-panel-heading">Files</h2>
          <p className="workspace-panel-meta">
            <code title={workspacePath}>{workspacePath}</code>{" "}
            <button type="button" className="button button-ghost" onClick={copyPath}>
              {copyState === "copied" ? "Copied ✓" : copyState === "failed" ? "Copy failed" : "Copy path"}
            </button>
            {summary && <span className="workspace-summary"> {summary}</span>}
          </p>
        </div>
        <div className="header-actions">
          {open && (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  if (event.target.files) void addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <button type="button" className="button button-ghost" disabled={editLocked} title={editHint} onClick={() => fileInput.current?.click()}>Add files</button>
              <button type="button" className="button button-ghost" disabled={editLocked} title={editHint} onClick={() => setNewFilePath((value) => (value === null ? "" : value))}>New file</button>
              <button type="button" className="button button-danger" disabled={editLocked} title={editHint} onClick={() => void resetWorkspace()}>Reset…</button>
              <button type="button" className="button button-ghost" onClick={() => { if (confirmDiscardEdits()) refresh(); }}>Refresh</button>
              {pending && <span className="workspace-row-meta" role="status">Saving…</span>}
            </>
          )}
          <button type="button" className="button button-ghost" onClick={() => setOpen((value) => !value)}>
            {open ? "Hide files" : "Browse files"}
          </button>
        </div>
      </div>

      {open && busy && <p className="workspace-note">{BUSY_HINT} — editing is disabled until the run finishes.</p>}
      {open && error && <p className="error-banner" role="alert">{error}</p>}
      {open && newFilePath !== null && (
        <form
          className="workspace-newfile"
          onSubmit={(event) => { event.preventDefault(); void createFile(); }}
        >
          <label>
            New file path
            <input
              value={newFilePath}
              onChange={(event) => setNewFilePath(event.target.value)}
              placeholder="src/notes.md"
              autoFocus
            />
          </label>
          <button type="submit" className="button button-primary" disabled={editLocked} title={editHint}>Create</button>
          <button type="button" className="button button-ghost" onClick={() => setNewFilePath(null)}>Cancel</button>
        </form>
      )}
      {open && truncated && (
        <p className="workspace-note">Large directory: only the first 2,000 entries per folder are listed.</p>
      )}
      {open && rootListing && rows.length === 0 && <p className="workspace-note">This workspace is empty.</p>}
      {open && !rootListing && !error && <p className="workspace-note">Loading workspace…</p>}

      {open && rows.length > 0 && (
        <div className="workspace-tree" role="tree" aria-label="Workspace files">
          {rows.map((row, index) => (
            <Fragment key={row.path}>
            <div
              ref={(element) => { if (element) rowRefs.current.set(row.path, element); else rowRefs.current.delete(row.path); }}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={preview?.path === row.path}
              {...(row.kind === "dir" ? { "aria-expanded": row.expanded } : {})}
              tabIndex={focusPath === null ? (index === 0 ? 0 : -1) : focusPath === row.path ? 0 : -1}
              className={"workspace-row" + (preview?.path === row.path ? " selected" : "")}
              style={{ paddingLeft: 12 + row.depth * 16 }}
              onClick={() => { focusRow(row.path); activate(row); }}
              onKeyDown={(event) => onRowKey(event, index)}
            >
              <span className="workspace-row-kind" aria-hidden="true">
                {row.kind === "dir" ? (row.expanded ? "▾" : "▸") : row.kind === "symlink" ? "↪" : "·"}
              </span>
              <span className="workspace-row-name">{row.name}</span>
              <span className="workspace-row-meta">
                {row.kind === "file" ? formatBytes(row.size) : row.kind === "symlink" ? "symlink" : ""}
              </span>
            </div>
            {/* #341: an expanded directory shows a placeholder child until its listing lands. */}
            {row.kind === "dir" && row.expanded && !row.loaded && (
              <div className="workspace-row" role="none" style={{ paddingLeft: 12 + (row.depth + 1) * 16 }}>
                <span className="workspace-row-kind" aria-hidden="true">·</span>
                <span className="workspace-row-meta">loading…</span>
              </div>
            )}
            </Fragment>
          ))}
        </div>
      )}

      {open && preview && (
        <div className="workspace-preview">
          <div className="workspace-preview-head">
            <h3><code>{preview.path}</code>{preview.managed && <span className="workspace-managed-badge" title="Written by the platform; regenerated on Agent updates — edit the Agent instead."> managed</span>}</h3>
            <div className="header-actions">
              {canEditPreview && editText === null && (
                <button type="button" className="button button-ghost" disabled={editLocked} title={editHint} onClick={() => setEditText(preview.content ?? "")}>Edit</button>
              )}
              {!preview.managed && editText === null && (
                <button type="button" className="button button-ghost" disabled={editLocked} title={editHint} onClick={() => void deleteFile()}>Delete</button>
              )}
              <button type="button" className="button button-ghost" onClick={closePreview}>Close</button>
            </div>
          </div>
          <p className="workspace-panel-meta">
            {formatBytes(preview.size)} · <span title={preview.mtime}>{formatClock(preview.mtime)}</span> · {preview.encoding}
          </p>
          {editText !== null ? (
            <div className="workspace-editor">
              <textarea
                value={editText}
                onChange={(event) => setEditText(event.target.value)}
                // #344: Escape in the editor routes through the same guarded close as everywhere
                // else; stopPropagation keeps the panel-level Escape from firing a second time.
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    closePreview();
                  }
                }}
                rows={16}
                spellCheck={false}
                aria-label={"Edit " + preview.path}
              />
              <div className="header-actions">
                <button type="button" className="button button-primary" disabled={editLocked} title={editHint} onClick={() => void saveEdit()}>Save</button>
                <button type="button" className="button button-ghost" onClick={() => setEditText(null)}>Cancel</button>
              </div>
            </div>
          ) : preview.content !== undefined ? (
            <pre className="workspace-preview-content">{preview.content}</pre>
          ) : (
            <p className="workspace-note">
              {preview.encoding === "binary"
                ? "Binary file — metadata only."
                : "File exceeds the 256 KB preview limit — metadata only."}
            </p>
          )}
        </div>
      )}

      {open && recentChanges.length > 0 && (
        <div className="workspace-history">
          <h3>Recent changes</h3>
          <ul>
            {recentChanges.map((entry, index) => (
              <li key={entry.at + ":" + index}>{describeHistoryEntry(entry)}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
