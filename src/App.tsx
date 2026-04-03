import { useEffect, useState, useMemo } from "react";
import "./App.css";

const isTauri = typeof window !== "undefined" && "__TAURI__" in window;

async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  await new Promise((r) => setTimeout(r, 600));
  if (cmd === "startup_check") {
    const now = Math.floor(Date.now() / 1000);
    return {
      has_local_changes: true,
      has_remote_changes: false,
      changed_files: [
        { path: "契約書/2026/A社_契約書.docx",          status: "modified", modified_at: now - 3600 },
        { path: "契約書/2026/B社_覚書.docx",             status: "modified", modified_at: now - 7200 },
        { path: "契約書/2025/旧契約_C社.docx",           status: "deleted",  modified_at: now - 86400 },
        { path: "議事録/2026-04-03_定例会議.docx",       status: "new",      modified_at: now - 1800 },
        { path: "議事録/2026-04-01_キックオフ.docx",     status: "modified", modified_at: now - 172800 },
        { path: "報告書/月次レポート_2026-03.xlsx",       status: "modified", modified_at: now - 600 },
        { path: "企画書/新サービス企画書.docx",           status: "new",      modified_at: now - 300 },
      ],
      offline: false,
    } as T;
  }
  return undefined as T;
}

interface ChangedFile {
  path: string;
  status: "modified" | "new" | "deleted";
  modified_at?: number; // Unix秒
}

interface StartupCheckResult {
  has_local_changes: boolean;
  has_remote_changes: boolean;
  changed_files: ChangedFile[];
  offline: boolean;
}

type SyncState = "loading" | "syncing" | "ready" | "conflict" | "offline" | "error";
type SortKey = "name" | "status" | "modified";
type SortDir = "asc" | "desc";

const REPO_PATH = "C:\\Users\\PC_User\\ClaudeWork\\syncroom";
const STATUS_LABEL: Record<string, string> = { modified: "変更", new: "新規", deleted: "削除" };

// ── ツリー構造 ────────────────────────────
interface FolderNode {
  name: string;
  path: string;
  children: Map<string, FolderNode>;
  files: ChangedFile[];
}

function buildTree(files: ChangedFile[]): FolderNode {
  const root: FolderNode = { name: "", path: "", children: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.replace(/\\/g, "/").split("/");
    const fileName = parts.pop()!;
    let cur = root;
    for (const part of parts) {
      if (!cur.children.has(part)) {
        cur.children.set(part, {
          name: part,
          path: cur.path ? `${cur.path}/${part}` : part,
          children: new Map(),
          files: [],
        });
      }
      cur = cur.children.get(part)!;
    }
    cur.files.push({ ...file });
  }
  return root;
}

function sortFiles(files: ChangedFile[], key: SortKey, dir: SortDir): ChangedFile[] {
  return [...files].sort((a, b) => {
    let cmp = 0;
    if (key === "name") {
      const an = a.path.split("/").pop() ?? "";
      const bn = b.path.split("/").pop() ?? "";
      cmp = an.localeCompare(bn, "ja");
    } else if (key === "status") {
      cmp = a.status.localeCompare(b.status);
    } else if (key === "modified") {
      cmp = (a.modified_at ?? 0) - (b.modified_at ?? 0);
    }
    return dir === "asc" ? cmp : -cmp;
  });
}

// ── ユーティリティ ────────────────────────
function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    docx: "📄", doc: "📄", xlsx: "📊", xls: "📊",
    pptx: "📑", ppt: "📑", pdf: "📕", txt: "📝",
    png: "🖼", jpg: "🖼", jpeg: "🖼",
  };
  return map[ext] ?? "📄";
}

function formatDate(unix?: number): string {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (isToday) return `今日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── ツリー行コンポーネント ─────────────────
function FileRow({
  file, depth, sortKey, sortDir, hoveredPath, setHoveredPath,
}: {
  file: ChangedFile;
  depth: number;
  sortKey: SortKey;
  sortDir: SortDir;
  hoveredPath: string | null;
  setHoveredPath: (p: string | null) => void;
}) {
  const name = file.path.split("/").pop() ?? file.path;
  const isHovered = hoveredPath === file.path;
  return (
    <div
      className={`explorer-row${isHovered ? " hovered" : ""}`}
      onMouseEnter={() => setHoveredPath(file.path)}
      onMouseLeave={() => setHoveredPath(null)}
    >
      <div className="col-status">
        <span className={`status-badge ${file.status}`}>{STATUS_LABEL[file.status]}</span>
      </div>
      <div className="col-name" style={{ paddingLeft: `${12 + depth * 20}px` }}>
        <span className="file-icon">{fileIcon(name)}</span>
        <span className="file-name">{name}</span>
      </div>
      <div className="col-modified">
        <span className="modified-text">{formatDate(file.modified_at)}</span>
      </div>
      <div className="col-action">
        {isHovered && file.status !== "new" && (
          <button className="btn-revert">↩ 元に戻す</button>
        )}
      </div>
    </div>
  );
}

function FolderRow({
  node, depth, expanded, onToggle, sortKey, sortDir, hoveredPath, setHoveredPath,
}: {
  node: FolderNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  sortKey: SortKey;
  sortDir: SortDir;
  hoveredPath: string | null;
  setHoveredPath: (p: string | null) => void;
}) {
  const isOpen = expanded.has(node.path);
  const totalCount = countFiles(node);

  return (
    <>
      <div className="explorer-row folder-row" onClick={() => onToggle(node.path)}>
        <div className="col-status" />
        <div className="col-name" style={{ paddingLeft: `${12 + depth * 20}px` }}>
          <span className="chevron">{isOpen ? "▾" : "▸"}</span>
          <span className="folder-icon">📁</span>
          <span className="folder-row-name">{node.name}</span>
          <span className="folder-count">{totalCount}件</span>
        </div>
        <div className="col-modified" />
        <div className="col-action" />
      </div>
      {isOpen && (
        <>
          {/* サブフォルダ */}
          {[...node.children.values()].map((child) => (
            <FolderRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              sortKey={sortKey}
              sortDir={sortDir}
              hoveredPath={hoveredPath}
              setHoveredPath={setHoveredPath}
            />
          ))}
          {/* ファイル */}
          {sortFiles(node.files, sortKey, sortDir).map((f) => (
            <FileRow
              key={f.path}
              file={f}
              depth={depth + 1}
              sortKey={sortKey}
              sortDir={sortDir}
              hoveredPath={hoveredPath}
              setHoveredPath={setHoveredPath}
            />
          ))}
        </>
      )}
    </>
  );
}

function countFiles(node: FolderNode): number {
  let count = node.files.length;
  for (const child of node.children.values()) count += countFiles(child);
  return count;
}

// ── メイン ────────────────────────────────
export default function App() {
  const [syncState, setSyncState]       = useState<SyncState>("loading");
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);
  const [offline, setOffline]           = useState(false);
  const [errorMsg, setErrorMsg]         = useState("");
  const [hoveredPath, setHoveredPath]   = useState<string | null>(null);
  const [sortKey, setSortKey]           = useState<SortKey>("name");
  const [sortDir, setSortDir]           = useState<SortDir>("asc");
  const [expanded, setExpanded]         = useState<Set<string>>(new Set());

  useEffect(() => { runStartupCheck(); }, []);

  async function runStartupCheck() {
    setSyncState("loading");
    try {
      const result = await invokeCmd<StartupCheckResult>("startup_check", { repoPath: REPO_PATH });
      setChangedFiles(result.changed_files);
      setOffline(result.offline);

      // フォルダを全展開
      const folders = new Set<string>();
      result.changed_files.forEach((f) => {
        const parts = f.path.replace(/\\/g, "/").split("/");
        parts.pop();
        let cur = "";
        for (const p of parts) {
          cur = cur ? `${cur}/${p}` : p;
          folders.add(cur);
        }
      });
      setExpanded(folders);

      if (result.offline) {
        setSyncState("offline");
      } else if (!result.has_local_changes && result.has_remote_changes) {
        setSyncState("syncing");
        await invokeCmd("pull", { repoPath: REPO_PATH });
        setSyncState("ready");
      } else if (result.has_local_changes && result.has_remote_changes) {
        setSyncState("conflict");
      } else {
        setSyncState("ready");
      }
    } catch (e) {
      setErrorMsg(String(e));
      setSyncState("error");
    }
  }

  async function handleSaveAndSync() {
    setSyncState("syncing");
    try {
      await invokeCmd("pull", { repoPath: REPO_PATH });
      setSyncState("ready");
    } catch (e) {
      setErrorMsg(String(e));
      setSyncState("error");
    }
  }

  function toggleFolder(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <span className="sort-icon muted">⇅</span>;
    return <span className="sort-icon">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  const tree = useMemo(() => buildTree(changedFiles), [changedFiles]);

  if (syncState === "loading" || syncState === "syncing") {
    return (
      <div className="center-screen">
        <div className="spinner" />
        <p className="status-text">
          {syncState === "loading" ? "起動中..." : "最新の状態に更新中..."}
        </p>
      </div>
    );
  }

  if (syncState === "error") {
    return (
      <div className="center-screen">
        <p className="status-text error">エラーが発生しました</p>
        <p className="error-detail">{errorMsg}</p>
        <button className="btn-primary" onClick={runStartupCheck}>再試行</button>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">SyncRoom</span>
        <span className={`sync-badge ${offline ? "offline" : "synced"}`}>
          {offline ? "● オフライン" : "● クラウドと同期済み"}
        </span>
      </header>

      {syncState === "conflict" && (
        <div className="conflict-banner">
          <span>⚠️ 保存していない変更があります。先に保存してから最新化しますか？</span>
          <div className="conflict-actions">
            <button className="btn-primary" onClick={handleSaveAndSync}>保存して最新化</button>
            <button className="btn-ghost" onClick={() => setSyncState("ready")}>後で</button>
          </div>
        </div>
      )}

      <div className="toolbar">
        <span className="toolbar-count">
          {changedFiles.length > 0 ? `${changedFiles.length} 件の変更` : "変更なし"}
        </span>
      </div>

      <div className="explorer">
        {/* カラムヘッダー */}
        <div className="explorer-header">
          <div className="col-status">
            <button className="col-btn" onClick={() => handleSort("status")}>
              状態 <SortIcon k="status" />
            </button>
          </div>
          <div className="col-name">
            <button className="col-btn" onClick={() => handleSort("name")}>
              ファイル名 <SortIcon k="name" />
            </button>
          </div>
          <div className="col-modified">
            <button className="col-btn" onClick={() => handleSort("modified")}>
              更新日時 <SortIcon k="modified" />
            </button>
          </div>
          <div className="col-action" />
        </div>

        {/* ツリー本体 */}
        <div className="explorer-body">
          {changedFiles.length === 0 ? (
            <div className="no-changes">変更されたファイルはありません</div>
          ) : (
            <>
              {/* ルート直下のサブフォルダ */}
              {[...tree.children.values()].map((node) => (
                <FolderRow
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggleFolder}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  hoveredPath={hoveredPath}
                  setHoveredPath={setHoveredPath}
                />
              ))}
              {/* ルート直下のファイル */}
              {sortFiles(tree.files, sortKey, sortDir).map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  depth={0}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  hoveredPath={hoveredPath}
                  setHoveredPath={setHoveredPath}
                />
              ))}
            </>
          )}
        </div>
      </div>

      {changedFiles.length > 0 && (
        <footer className="app-footer">
          <button className="btn-save">💾 保存する（{changedFiles.length}件）</button>
        </footer>
      )}
    </div>
  );
}
