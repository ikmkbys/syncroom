use git2::{build::CheckoutBuilder, FetchOptions, Repository, Status, StatusOptions};
use serde::{Deserialize, Serialize};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize, Clone)]
pub struct ChangedFile {
    pub path: String,
    pub status: String,       // "modified" | "new" | "deleted"
    pub modified_at: Option<u64>, // Unix秒（ファイルの更新日時）
}

#[derive(Serialize, Deserialize)]
pub struct StartupCheckResult {
    pub has_local_changes: bool,
    pub has_remote_changes: bool,
    pub changed_files: Vec<ChangedFile>,
    pub offline: bool,
}

// 未コミットのファイル一覧を取得
fn get_changed_files(repo: &Repository) -> Result<Vec<ChangedFile>, git2::Error> {
    let workdir = repo.workdir().ok_or(git2::Error::from_str("bare repository"))?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(false);
    let statuses = repo.statuses(Some(&mut opts))?;

    let files = statuses
        .iter()
        .filter_map(|entry| {
            let s = entry.status();
            let path = entry.path()?.to_string();
            let status_str = if s.intersects(Status::INDEX_NEW | Status::WT_NEW) {
                "new"
            } else if s.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
                "deleted"
            } else {
                "modified"
            };
            // ファイルの更新日時を取得（削除済みは None）
            let modified_at = std::fs::metadata(workdir.join(&path))
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs());

            Some(ChangedFile {
                path,
                status: status_str.to_string(),
                modified_at,
            })
        })
        .collect();

    Ok(files)
}

// fetchしてリモートに新しいコミットがあるか確認
fn fetch_and_check(repo: &Repository) -> Result<bool, git2::Error> {
    let head = repo.head()?;
    let branch = head.shorthand().unwrap_or("main").to_string();

    let mut remote = repo.find_remote("origin")?;
    let mut fetch_opts = FetchOptions::new();
    remote.fetch(&[&branch], Some(&mut fetch_opts), None)?;

    let local_oid = repo.head()?.peel_to_commit()?.id();
    let fetch_head = repo.find_reference("FETCH_HEAD")?;
    let remote_oid = fetch_head.peel_to_commit()?.id();

    Ok(local_oid != remote_oid)
}

// fast-forward pull
fn do_pull(repo: &Repository) -> Result<(), String> {
    let head = repo.head().map_err(|e| e.message().to_string())?;
    let branch = head.shorthand().unwrap_or("main").to_string();

    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| e.message().to_string())?;
    let mut fetch_opts = FetchOptions::new();
    remote
        .fetch(&[&branch], Some(&mut fetch_opts), None)
        .map_err(|e| e.message().to_string())?;

    let fetch_head = repo
        .find_reference("FETCH_HEAD")
        .map_err(|e| e.message().to_string())?;
    let fetch_commit = repo
        .reference_to_annotated_commit(&fetch_head)
        .map_err(|e| e.message().to_string())?;

    let (analysis, _) = repo
        .merge_analysis(&[&fetch_commit])
        .map_err(|e| e.message().to_string())?;

    if analysis.is_fast_forward() {
        let refname = format!("refs/heads/{}", branch);
        let mut reference = repo
            .find_reference(&refname)
            .map_err(|e| e.message().to_string())?;
        reference
            .set_target(fetch_commit.id(), "Fast-Forward")
            .map_err(|e| e.message().to_string())?;
        repo.set_head(&refname)
            .map_err(|e| e.message().to_string())?;
        repo.checkout_head(Some(&mut CheckoutBuilder::default().force()))
            .map_err(|e| e.message().to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn startup_check(repo_path: String) -> Result<StartupCheckResult, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;

    let changed_files = get_changed_files(&repo).map_err(|e| e.message().to_string())?;
    let has_local_changes = !changed_files.is_empty();

    let (has_remote_changes, offline) = match fetch_and_check(&repo) {
        Ok(has_changes) => (has_changes, false),
        Err(_) => (false, true),
    };

    Ok(StartupCheckResult {
        has_local_changes,
        has_remote_changes,
        changed_files,
        offline,
    })
}

#[tauri::command]
fn pull(repo_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    do_pull(&repo)
}

#[tauri::command]
fn get_status(repo_path: String) -> Result<Vec<ChangedFile>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.message().to_string())?;
    get_changed_files(&repo).map_err(|e| e.message().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![startup_check, pull, get_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
