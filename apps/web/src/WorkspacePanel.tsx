import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { WorkspaceFile, WorkspaceListing } from "./types";
import {
  flattenWorkspaceTree,
  formatBytes,
  parentPath,
  workspaceSummaryLine,
  type WorkspaceRow,
} from "./workspace-view-model";

interface Props {
  agentId: string;
  workspacePath: string;
  fileCount?: number | undefined;
  lastModified?: string | undefined;
}

// #65: read-only workspace browser in the Agent detail. Listings are fetched lazily per directory
// through api.ts (GET /api/agents/:id/workspace[/file]); nothing here can write. The tree follows
// the trace tree's keyboard contract: arrows move/expand, Enter previews, Escape steps back.
export default function WorkspacePanel({ agentId, workspacePath, fileCount, lastModified }: Props) {
  const [open, setOpen] = useState(false);
  const [listings, setListings] = useState<Map<string, WorkspaceListing>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [focusReq, setFocusReq] = useState(0);
  const [preview, setPreview] = useState<WorkspaceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const loading = useRef(new Set<string>());

  const loadListing = async (path: string): Promise<void> => {
    if (loading.current.has(path)) return;
    loading.current.add(path);
    try {
      const listing = await api.browseWorkspace(agentId, path);
      setListings((previous) => new Map(previous).set(path, listing));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
  }, [agentId]);

  useEffect(() => {
    if (open && !listings.has("")) void loadListing("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentId]);

  useEffect(() => {
    if (focusPath !== null) rowRefs.current.get(focusPath)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq]);

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

  const openPreview = async (row: WorkspaceRow) => {
    try {
      setPreview(await api.readWorkspaceFile(agentId, row.path));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const closePreview = () => {
    const back = preview?.path;
    setPreview(null);
    if (back) focusRow(back);
  };

  const refresh = () => {
    setPreview(null);
    void loadListing("");
    for (const path of expanded) if (listings.has(path)) void loadListing(path);
  };

  const activate = (row: WorkspaceRow) => {
    if (row.kind === "dir") toggleDir(row);
    else void openPreview(row);
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

  return (
    <section className="workspace-panel" aria-labelledby="workspace-panel-heading">
      <div className="workspace-panel-head">
        <div>
          <span className="eyebrow">Workspace</span>
          <h2 id="workspace-panel-heading">Files</h2>
          <p className="workspace-panel-meta">
            <code title={workspacePath}>{workspacePath}</code>{" "}
            <button type="button" className="button button-ghost" onClick={() => void navigator.clipboard.writeText(workspacePath)}>Copy path</button>
            {summary && <span className="workspace-summary"> {summary}</span>}
          </p>
        </div>
        <div className="header-actions">
          {open && <button type="button" className="button button-ghost" onClick={refresh}>Refresh</button>}
          <button type="button" className="button button-ghost" onClick={() => setOpen((value) => !value)}>
            {open ? "Hide files" : "Browse files"}
          </button>
        </div>
      </div>

      {open && error && <p className="error-banner" role="alert">{error}</p>}
      {open && truncated && (
        <p className="workspace-note">Large directory: only the first 2,000 entries per folder are listed.</p>
      )}
      {open && rootListing && rows.length === 0 && <p className="workspace-note">This workspace is empty.</p>}
      {open && !rootListing && !error && <p className="workspace-note">Loading workspace…</p>}

      {open && rows.length > 0 && (
        <div className="workspace-tree" role="tree" aria-label="Workspace files">
          {rows.map((row, index) => (
            <div
              key={row.path}
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
          ))}
        </div>
      )}

      {open && preview && (
        <div className="workspace-preview">
          <div className="workspace-preview-head">
            <h3><code>{preview.path}</code>{preview.managed && <span className="workspace-managed-badge" title="Written by the platform; regenerated on Agent updates."> managed</span>}</h3>
            <button type="button" className="button button-ghost" onClick={closePreview}>Close</button>
          </div>
          <p className="workspace-panel-meta">
            {formatBytes(preview.size)} · {new Date(preview.mtime).toLocaleString()} · {preview.encoding}
          </p>
          {preview.content !== undefined ? (
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
    </section>
  );
}
