//! Bounded catalog and runtime ownership. Session actors retain all transcript/command state.
use crate::{
    catalog::{Catalog, CatalogEntry, MAX_SESSIONS, valid_id},
    config::{self, Config, Startup},
    metadata::{MetadataStore, SessionMetadata},
    ownership::Ownership,
    protocol::*,
    session::{self, SessionHandle},
    workspaces::{
        MAX_WORKSPACES, Registry, WorkspaceRecord, canonical_folder, require_available_folder,
    },
};
use std::{
    collections::{BTreeMap, VecDeque},
    io,
    io::BufRead,
    sync::Arc,
};
use tokio::sync::{Mutex, watch};

pub const MAX_ACTIVE: usize = 4;
const CACHE_BYTES: usize = 512 * 1024;
#[derive(Clone)]
pub struct SessionManager(Arc<Inner>);
struct Inner {
    config: Config,
    registry_store: MetadataStore,
    owners: Ownership,
    state: Mutex<State>,
}
struct Active {
    handle: SessionHandle,
    lifecycle: SlotStatus,
}
struct Cached {
    command: WorkspaceCommand,
    reply: watch::Sender<Option<WorkspaceReply>>,
}
struct Project {
    config: Config,
    store: Arc<MetadataStore>,
    catalog: Catalog,
}
struct State {
    registry: Registry,
    projects: BTreeMap<String, Project>,
    active: BTreeMap<String, Active>,
    requests: VecDeque<Cached>,
    stopping: bool,
}

impl SessionManager {
    /// Adopts legacy metadata in place and opens only the selected record. No Pi file is rewritten.
    pub fn start(config: Config) -> io::Result<Self> {
        let registry_store = MetadataStore::open(&config.registry_dir)?;
        let mut registry = Registry::load(&registry_store)?;
        if config.explicit_cwd || registry.entries.is_empty() {
            let cwd = canonical_folder(&config.cwd)?;
            if let Some(entry) = registry.entries.iter().find(|entry| entry.cwd == cwd) {
                registry.selected = entry.id.clone();
            } else {
                if registry.entries.len() >= MAX_WORKSPACES {
                    return Err(io::Error::other("workspace capacity reached"));
                }
                let id = config::identity()?;
                let state_dir = if registry.entries.is_empty() {
                    config.state_dir.clone()
                } else {
                    config.additional_state_dir(&cwd)
                };
                registry.entries.push(WorkspaceRecord {
                    id: id.clone(),
                    cwd,
                    state_dir,
                });
                registry.selected = id;
            }
        }
        let mut projects = BTreeMap::new();
        for record in &registry.entries {
            let mut options = config.for_project(record.cwd.clone(), record.state_dir.clone());
            if record.id == registry.selected {
                options.startup = config.startup.clone();
            }
            let store = Arc::new(MetadataStore::open(&options.state_dir)?);
            let catalog = Self::load_catalog(&options, &store)?;
            projects.insert(
                record.id.clone(),
                Project {
                    config: options,
                    store,
                    catalog,
                },
            );
        }
        // Persist before launching: registry failures cannot leave a runtime orphan.
        registry.save(&registry_store)?;
        let project = &projects[&registry.selected];
        let entry = project
            .catalog
            .entries
            .iter()
            .find(|entry| entry.id == project.catalog.selected)
            .unwrap();
        let owners = Ownership::default();
        let handle = Self::launch(&project.config, &project.store, entry, owners.clone())?;
        let active = BTreeMap::from([(
            entry.id.clone(),
            Active {
                handle,
                lifecycle: SlotStatus::Open,
            },
        )]);
        Ok(Self(Arc::new(Inner {
            config,
            registry_store,
            owners,
            state: Mutex::new(State {
                registry,
                projects,
                active,
                requests: VecDeque::new(),
                stopping: false,
            }),
        })))
    }
    /// Loads legacy metadata in place; only the startup project applies CLI session selection.
    fn load_catalog(config: &Config, store: &Arc<MetadataStore>) -> io::Result<Catalog> {
        let mut catalog = match Catalog::load(store, &config.cwd)? {
            Some(catalog) => catalog,
            None => {
                let entries = if let Some(saved) = store.load()? {
                    if saved.cwd != config.cwd {
                        return Err(io::Error::other("metadata belongs to a different project"));
                    }
                    vec![CatalogEntry {
                        id: saved.app_id,
                        title: "Conversation 1".into(),
                        legacy: true,
                    }]
                } else {
                    Vec::new()
                };
                Catalog {
                    version: 1,
                    cwd: config.cwd.clone(),
                    selected: entries
                        .first()
                        .map_or_else(String::new, |entry| entry.id.clone()),
                    entries,
                }
            }
        };
        match &config.startup {
            Startup::New => {
                Self::add_record(config, store, &mut catalog, None)?;
            }
            Startup::Session(path) => {
                let path =
                    crate::metadata::validate_session(path, &config.session_roots, &config.cwd)?;
                let existing = catalog.entries.iter().find_map(|entry| {
                    Self::record_store(config, store, entry)
                        .ok()?
                        .load()
                        .ok()??
                        .pi_session_path
                        .filter(|saved| saved.canonicalize().ok().as_ref() == Some(&path))
                        .map(|_| entry.id.clone())
                });
                if let Some(id) = existing {
                    catalog.selected = id;
                } else {
                    Self::add_record(config, store, &mut catalog, Some(path))?;
                }
            }
            Startup::Remembered if catalog.entries.is_empty() => {
                Self::add_record(config, store, &mut catalog, None)?;
            }
            Startup::Remembered => {}
        }
        catalog.save(store)?;
        Ok(catalog)
    }
    fn record_store(
        config: &Config,
        root: &Arc<MetadataStore>,
        entry: &CatalogEntry,
    ) -> io::Result<Arc<MetadataStore>> {
        if entry.legacy {
            Ok(root.clone())
        } else {
            Ok(Arc::new(MetadataStore::open(
                &config.state_dir.join("sessions").join(&entry.id),
            )?))
        }
    }
    fn launch(
        config: &Config,
        root: &Arc<MetadataStore>,
        entry: &CatalogEntry,
        owners: Ownership,
    ) -> io::Result<SessionHandle> {
        require_available_folder(&config.cwd)?;
        let store = Self::record_store(config, root, entry)?;
        let metadata = store
            .load()?
            .ok_or_else(|| io::Error::other("catalog record is missing"))?;
        if metadata.app_id != entry.id {
            return Err(io::Error::other("catalog identity mismatch"));
        }
        let mut options = config.clone();
        options.startup = Startup::Remembered;
        if !entry.legacy {
            options.state_dir = config.state_dir.join("sessions").join(&entry.id);
        }
        options
            .session_roots
            .push(config.state_dir.join("sessions"));
        session::start_owned(options, store, metadata, owners)
    }
    fn add_record(
        config: &Config,
        root: &Arc<MetadataStore>,
        catalog: &mut Catalog,
        import: Option<std::path::PathBuf>,
    ) -> io::Result<String> {
        if catalog.entries.len() >= MAX_SESSIONS {
            return Err(io::Error::other("catalog capacity reached"));
        }
        let id = config::identity()?;
        let entry = CatalogEntry {
            id: id.clone(),
            title: format!("Conversation {}", catalog.entries.len() + 1),
            legacy: false,
        };
        let pi_id = if let Some(path) = &import {
            let file = std::fs::File::open(path)?;
            let mut line = String::new();
            use std::io::Read;
            std::io::BufReader::new(file.take(65537)).read_line(&mut line)?;
            let header: serde_json::Value =
                serde_json::from_str(&line).map_err(io::Error::other)?;
            Some(
                header["id"]
                    .as_str()
                    .ok_or_else(|| io::Error::other("missing Pi identity"))?
                    .to_string(),
            )
        } else {
            None
        };
        let metadata = SessionMetadata {
            version: 1,
            app_id: id.clone(),
            cwd: config.cwd.clone(),
            pi_session_id: pi_id,
            persisted: import.is_some(),
            pi_session_path: import,
        };
        Self::record_store(config, root, &entry)?.save(&metadata)?;
        let mut next = catalog.clone();
        next.entries.push(entry);
        next.selected = id.clone();
        next.save(root)?;
        *catalog = next;
        Ok(id)
    }
    /// Resolves only active generated IDs; never interprets browser input as a path.
    pub async fn lookup(&self, id: &str) -> Option<SessionHandle> {
        let state = self.0.state.lock().await;
        state
            .active
            .get(id)
            .filter(|slot| slot.lifecycle == SlotStatus::Open)
            .map(|slot| slot.handle.clone())
    }
    pub async fn snapshot(&self) -> WorkspaceReply {
        let state = self.0.state.lock().await;
        Self::reply(&state, None, true, "catalog")
    }
    fn reply(state: &State, request_id: Option<String>, ok: bool, code: &str) -> WorkspaceReply {
        WorkspaceReply {
            v: 2,
            request_id,
            ok,
            code: code.into(),
            target: None,
            selected: state.projects[&state.registry.selected]
                .catalog
                .selected
                .clone(),
            selected_workspace: state.registry.selected.clone(),
            workspaces: state
                .registry
                .entries
                .iter()
                .map(|record| WorkspaceItem {
                    workspace_id: record.id.clone(),
                    name: workspace_name(&record.cwd),
                    path: record.cwd.to_string_lossy().into_owned(),
                })
                .collect(),
            sessions: state
                .projects
                .iter()
                .flat_map(|(workspace_id, project)| {
                    project.catalog.entries.iter().map(|entry| {
                        let slot = state.active.get(&entry.id);
                        CatalogItem {
                            workspace_id: workspace_id.clone(),
                            session_id: entry.id.clone(),
                            title: entry.title.clone(),
                            lifecycle: slot
                                .map_or(SlotStatus::Stopped, |slot| slot.lifecycle.clone()),
                            runtime: slot.map(|slot| slot.handle.summary()),
                        }
                    })
                })
                .collect(),
        }
    }
    /// Deduplicates bounded management requests. The owned operation survives a socket disconnect.
    pub async fn command(&self, command: WorkspaceCommand) -> WorkspaceReply {
        let mut state = self.0.state.lock().await;
        let request_id = command.request_id.clone();
        let token = &command.request_id;
        let valid = command.v == 2
            && !token.is_empty()
            && token.len() <= 64
            && token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            && match &command.action {
                WorkspaceAction::List | WorkspaceAction::Create => true,
                WorkspaceAction::CreateIn { workspace_id }
                | WorkspaceAction::SelectWorkspace { workspace_id } => valid_id(workspace_id),
                WorkspaceAction::AddWorkspace { path, .. } => path.len() <= 1024,
                WorkspaceAction::Open { session_id }
                | WorkspaceAction::Rename { session_id, .. }
                | WorkspaceAction::Subscribe { session_id }
                | WorkspaceAction::Unsubscribe { session_id } => valid_id(session_id),
                WorkspaceAction::Delete {
                    session_id, epoch, ..
                } => valid_id(session_id) && epoch.as_deref().is_none_or(valid_id),
                WorkspaceAction::Stop {
                    session_id, epoch, ..
                } => valid_id(session_id) && valid_id(epoch),
            };
        if !valid || state.stopping {
            return Self::reply(&state, Some(token.clone()), false, "invalid_or_stopping");
        }
        let mut receiver = if let Some(cached) = state
            .requests
            .iter()
            .find(|entry| entry.command.request_id == *token)
        {
            if cached.command != command {
                return Self::reply(&state, Some(token.clone()), false, "request_id_conflict");
            }
            cached.reply.subscribe()
        } else {
            Self::trim(&mut state);
            if state.requests.len() >= 64 {
                return Self::reply(&state, Some(token.clone()), false, "overloaded");
            }
            let (send, receive) = watch::channel(None);
            state.requests.push_back(Cached {
                command: command.clone(),
                reply: send.clone(),
            });
            let manager = self.clone();
            tokio::spawn(async move {
                let result = manager.execute(&command).await;
                send.send_replace(Some(result));
                Self::trim(&mut *manager.0.state.lock().await);
            });
            receive
        };
        drop(state);
        loop {
            if let Some(reply) = receiver.borrow().clone() {
                return reply;
            }
            if receiver.changed().await.is_err() {
                return WorkspaceReply {
                    v: 2,
                    request_id: Some(request_id),
                    ok: false,
                    code: "manager_closed".into(),
                    target: None,
                    selected: String::new(),
                    sessions: vec![],
                    workspaces: vec![],
                    selected_workspace: String::new(),
                };
            }
        }
    }
    fn trim(state: &mut State) {
        let bytes: usize = state
            .requests
            .iter()
            .map(|cached| {
                cached.reply.borrow().as_ref().map_or(0, |reply| {
                    serde_json::to_vec(reply).map_or(0, |bytes| bytes.len())
                })
            })
            .sum();
        if state.requests.len() >= 64 || bytes > CACHE_BYTES {
            // Completed replies are expendable; pending correlations are never evicted.
            while state.requests.len() >= 32
                || state
                    .requests
                    .iter()
                    .map(|cached| {
                        cached.reply.borrow().as_ref().map_or(0, |reply| {
                            serde_json::to_vec(reply).map_or(0, |bytes| bytes.len())
                        })
                    })
                    .sum::<usize>()
                    > CACHE_BYTES / 2
            {
                let Some(index) = state
                    .requests
                    .iter()
                    .position(|cached| cached.reply.borrow().is_some())
                else {
                    break;
                };
                state.requests.remove(index);
            }
        }
    }
    async fn execute(&self, command: &WorkspaceCommand) -> WorkspaceReply {
        let mut state = self.0.state.lock().await;
        let id = Some(command.request_id.clone());
        if state.stopping {
            return Self::reply(&state, id, false, "stopping");
        }
        match &command.action {
            WorkspaceAction::List => Self::reply(&state, id, true, "catalog"),
            WorkspaceAction::AddWorkspace { path, confirmed } => {
                if !confirmed {
                    return Self::reply(&state, id, false, "confirmation_required");
                }
                let Ok(cwd) = canonical_folder(std::path::Path::new(path)) else {
                    return Self::reply(&state, id, false, "invalid_workspace_path");
                };
                if state.registry.entries.iter().any(|entry| entry.cwd == cwd) {
                    return Self::reply(&state, id, false, "workspace_exists");
                }
                if state.registry.entries.len() >= MAX_WORKSPACES {
                    return Self::reply(&state, id, false, "workspace_limit");
                }
                let result = (|| -> io::Result<(String, Project, Registry)> {
                    let workspace_id = config::identity()?;
                    let options = self
                        .0
                        .config
                        .for_project(cwd.clone(), self.0.config.additional_state_dir(&cwd));
                    let store = Arc::new(MetadataStore::open(&options.state_dir)?);
                    let catalog = Self::load_catalog(&options, &store)?;
                    let mut next = state.registry.clone();
                    next.entries.push(WorkspaceRecord {
                        id: workspace_id.clone(),
                        cwd,
                        state_dir: options.state_dir.clone(),
                    });
                    next.selected = workspace_id.clone();
                    next.save(&self.0.registry_store)?;
                    Ok((
                        workspace_id,
                        Project {
                            config: options,
                            store,
                            catalog,
                        },
                        next,
                    ))
                })();
                let Ok((workspace_id, project, registry)) = result else {
                    return Self::reply(&state, id, false, "workspace_write_failed");
                };
                let selected = project.catalog.selected.clone();
                state.projects.insert(workspace_id.clone(), project);
                state.registry = registry;
                if state.active.len() < MAX_ACTIVE {
                    let project = &state.projects[&workspace_id];
                    let entry = project
                        .catalog
                        .entries
                        .iter()
                        .find(|entry| entry.id == selected)
                        .unwrap();
                    match Self::launch(
                        &project.config,
                        &project.store,
                        entry,
                        self.0.owners.clone(),
                    ) {
                        Ok(handle) => {
                            state.active.insert(
                                selected.clone(),
                                Active {
                                    handle,
                                    lifecycle: SlotStatus::Open,
                                },
                            );
                        }
                        Err(_) => {
                            return Self::reply(
                                &state,
                                id,
                                false,
                                "launch_failed_record_preserved",
                            );
                        }
                    }
                }
                WorkspaceReply {
                    target: Some(selected),
                    ..Self::reply(&state, id, true, "workspace_added")
                }
            }
            WorkspaceAction::SelectWorkspace { workspace_id } => {
                let Some(project) = state.projects.get(workspace_id) else {
                    return Self::reply(&state, id, false, "unknown_workspace");
                };
                let selected = project.catalog.selected.clone();
                if self.select(&mut state, workspace_id, &selected).is_err() {
                    return Self::reply(&state, id, false, "workspace_write_failed");
                }
                WorkspaceReply {
                    target: Some(selected),
                    ..Self::reply(&state, id, true, "workspace_selected")
                }
            }
            WorkspaceAction::Create | WorkspaceAction::CreateIn { .. } => {
                let workspace_id = match &command.action {
                    WorkspaceAction::CreateIn { workspace_id } => workspace_id.clone(),
                    _ => state.registry.selected.clone(),
                };
                if !state.projects.contains_key(&workspace_id) {
                    return Self::reply(&state, id, false, "unknown_workspace");
                }
                if require_available_folder(&state.projects[&workspace_id].config.cwd).is_err() {
                    return Self::reply(&state, id, false, "workspace_unavailable");
                }
                if state.active.len() >= MAX_ACTIVE {
                    return Self::reply(&state, id, false, "active_limit");
                }
                let project = state.projects.get_mut(&workspace_id).unwrap();
                let Ok(new_id) =
                    Self::add_record(&project.config, &project.store, &mut project.catalog, None)
                else {
                    return Self::reply(&state, id, false, "catalog_write_failed_or_full");
                };
                if self.select(&mut state, &workspace_id, &new_id).is_err() {
                    return Self::reply(&state, id, false, "workspace_write_failed");
                }
                let project = &state.projects[&workspace_id];
                let entry = project
                    .catalog
                    .entries
                    .iter()
                    .find(|entry| entry.id == new_id)
                    .unwrap();
                match Self::launch(
                    &project.config,
                    &project.store,
                    entry,
                    self.0.owners.clone(),
                ) {
                    Ok(handle) => {
                        state.active.insert(
                            new_id.clone(),
                            Active {
                                handle,
                                lifecycle: SlotStatus::Open,
                            },
                        );
                        WorkspaceReply {
                            target: Some(new_id),
                            ..Self::reply(&state, id, true, "created")
                        }
                    }
                    Err(_) => Self::reply(&state, id, false, "launch_failed_record_preserved"),
                }
            }
            WorkspaceAction::Open { session_id } => {
                let Some(workspace_id) = state
                    .projects
                    .iter()
                    .find(|(_, project)| {
                        project
                            .catalog
                            .entries
                            .iter()
                            .any(|entry| entry.id == *session_id)
                    })
                    .map(|(id, _)| id.clone())
                else {
                    return Self::reply(&state, id, false, "unknown_session");
                };
                if require_available_folder(&state.projects[&workspace_id].config.cwd).is_err() {
                    return Self::reply(&state, id, false, "workspace_unavailable");
                }
                if let Some(active) = state.active.get(session_id) {
                    if active.lifecycle != SlotStatus::Open {
                        return Self::reply(&state, id, false, "cleanup_not_complete");
                    }
                } else if state.active.len() >= MAX_ACTIVE {
                    return Self::reply(&state, id, false, "active_limit");
                }
                if self.select(&mut state, &workspace_id, session_id).is_err() {
                    return Self::reply(&state, id, false, "workspace_write_failed");
                }
                if !state.active.contains_key(session_id) {
                    let project = &state.projects[&workspace_id];
                    let entry = project
                        .catalog
                        .entries
                        .iter()
                        .find(|entry| entry.id == *session_id)
                        .unwrap();
                    match Self::launch(
                        &project.config,
                        &project.store,
                        entry,
                        self.0.owners.clone(),
                    ) {
                        Ok(handle) => {
                            state.active.insert(
                                session_id.clone(),
                                Active {
                                    handle,
                                    lifecycle: SlotStatus::Open,
                                },
                            );
                        }
                        Err(_) => return Self::reply(&state, id, false, "session_open_failed"),
                    }
                }
                WorkspaceReply {
                    target: Some(session_id.clone()),
                    ..Self::reply(&state, id, true, "opened")
                }
            }
            WorkspaceAction::Rename { session_id, title } => {
                let title = title.trim();
                if title.is_empty() || title.len() > 64 || title.chars().any(char::is_control) {
                    return Self::reply(&state, id, false, "invalid_title");
                }
                let Some(project) = state.projects.values_mut().find(|project| {
                    project
                        .catalog
                        .entries
                        .iter()
                        .any(|entry| entry.id == *session_id)
                }) else {
                    return Self::reply(&state, id, false, "unknown_session");
                };
                let mut next = project.catalog.clone();
                next.entries
                    .iter_mut()
                    .find(|entry| entry.id == *session_id)
                    .unwrap()
                    .title = title.into();
                if next.save(&project.store).is_err() {
                    return Self::reply(&state, id, false, "catalog_write_failed");
                }
                project.catalog = next;
                Self::reply(&state, id, true, "renamed")
            }
            WorkspaceAction::Delete {
                session_id,
                epoch,
                confirmed,
            } => {
                if !confirmed {
                    return Self::reply(&state, id, false, "confirmation_required");
                }
                let Some(workspace_id) = state
                    .projects
                    .iter()
                    .find(|(_, project)| {
                        project
                            .catalog
                            .entries
                            .iter()
                            .any(|entry| entry.id == *session_id)
                    })
                    .map(|(id, _)| id.clone())
                else {
                    return Self::reply(&state, id, false, "unknown_session");
                };
                if let Some(slot) = state.active.get_mut(session_id) {
                    if slot.lifecycle != SlotStatus::Open {
                        return Self::reply(&state, id, false, "cleanup_not_complete");
                    }
                    let Some(epoch) = epoch else {
                        return Self::reply(&state, id, false, "stale_epoch");
                    };
                    let handle = slot.handle.clone();
                    slot.lifecycle = SlotStatus::Stopping;
                    drop(state);
                    let result = handle.stop(epoch.clone()).await;
                    state = self.0.state.lock().await;
                    match result {
                        Ok(true) => {
                            state.active.remove(session_id);
                        }
                        Ok(false) => {
                            state.active.get_mut(session_id).unwrap().lifecycle =
                                SlotStatus::CleanupFailed;
                            return Self::reply(&state, id, false, "cleanup_failed");
                        }
                        Err(code) => {
                            state.active.get_mut(session_id).unwrap().lifecycle = SlotStatus::Open;
                            return Self::reply(&state, id, false, code);
                        }
                    }
                }
                let project = state.projects.get_mut(&workspace_id).unwrap();
                let removed = match Self::delete_transcript(project, session_id, &self.0.owners) {
                    Ok(removed) => removed,
                    Err(_) => return Self::reply(&state, id, false, "transcript_delete_failed"),
                };
                if Self::forget_record(project, session_id).is_err() {
                    let code = if removed {
                        "catalog_write_failed_after_transcript_deleted"
                    } else {
                        "catalog_write_failed"
                    };
                    return Self::reply(&state, id, false, code);
                }
                let target = project.catalog.selected.clone();
                WorkspaceReply {
                    target: Some(target),
                    ..Self::reply(&state, id, true, "deleted")
                }
            }
            WorkspaceAction::Stop {
                session_id,
                epoch,
                confirmed,
            } => {
                if !confirmed {
                    return Self::reply(&state, id, false, "confirmation_required");
                }
                let Some(slot) = state.active.get_mut(session_id) else {
                    return Self::reply(&state, id, false, "session_not_open");
                };
                if slot.lifecycle != SlotStatus::Open {
                    return Self::reply(&state, id, false, "already_stopping");
                }
                let handle = slot.handle.clone();
                slot.lifecycle = SlotStatus::Stopping;
                drop(state);
                let result = handle.stop(epoch.clone()).await;
                let mut state = self.0.state.lock().await;
                match result {
                    Ok(true) => {
                        state.active.remove(session_id);
                        Self::reply(&state, id, true, "stopped")
                    }
                    Ok(false) => {
                        if let Some(slot) = state.active.get_mut(session_id) {
                            slot.lifecycle = SlotStatus::CleanupFailed;
                        }
                        Self::reply(&state, id, false, "cleanup_failed")
                    }
                    Err(code) => {
                        if let Some(slot) = state.active.get_mut(session_id) {
                            slot.lifecycle = SlotStatus::Open;
                        }
                        Self::reply(&state, id, false, code)
                    }
                }
            }
            WorkspaceAction::Subscribe { session_id }
            | WorkspaceAction::Unsubscribe { session_id } => Self::reply(
                &state,
                id,
                state
                    .active
                    .get(session_id)
                    .is_some_and(|slot| slot.lifecycle == SlotStatus::Open),
                "subscription",
            ),
        }
    }
    /// Removes the latest saved transcript after runtime cleanup, reserving it against
    /// other runtimes. Returns whether a file was unlinked; missing files permit retry.
    /// Validation and unlink errors leave the catalog intact.
    fn delete_transcript(
        project: &Project,
        session_id: &str,
        owners: &Ownership,
    ) -> io::Result<bool> {
        let entry = project
            .catalog
            .entries
            .iter()
            .find(|entry| entry.id == session_id)
            .ok_or_else(|| io::Error::other("catalog entry is missing"))?;
        let store = Self::record_store(&project.config, &project.store, entry)?;
        let saved = store
            .load()?
            .ok_or_else(|| io::Error::other("catalog record is missing"))?;
        if saved.app_id != session_id || saved.cwd != project.config.cwd {
            return Err(io::Error::other("catalog identity or project mismatch"));
        }
        let Some(path) = saved.pi_session_path.as_deref() else {
            return Ok(false);
        };
        let expected_id = saved
            .pi_session_id
            .as_deref()
            .ok_or_else(|| io::Error::other("missing Pi identity"))?;
        let exists = match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() => true,
            Ok(_) => return Err(io::Error::other("transcript must be a regular file")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error),
        };
        let canonical = if exists {
            path.canonicalize()?
        } else {
            path.parent()
                .ok_or_else(|| io::Error::other("missing transcript parent"))?
                .canonicalize()?
                .join(
                    path.file_name()
                        .ok_or_else(|| io::Error::other("missing transcript name"))?,
                )
        };
        if canonical != path {
            return Err(io::Error::other("transcript path was redirected"));
        }
        let mut roots = project.config.session_roots.clone();
        roots.push(project.config.state_dir.join("sessions"));
        if !roots
            .iter()
            .filter_map(|root| root.canonicalize().ok())
            .any(|root| canonical.starts_with(root))
        {
            return Err(io::Error::other("transcript is outside configured roots"));
        }
        owners.claim(session_id, Some(path))?;
        let result = (|| {
            if !exists {
                return Ok(false);
            }
            crate::metadata::validate_session_identity(
                path,
                &roots,
                &project.config.cwd,
                Some(expected_id),
            )?;
            std::fs::remove_file(path)?;
            Ok(true)
        })();
        owners.release(session_id);
        result
    }

    /// Atomically forgets one entry, preserving a nonempty workspace catalog.
    /// A final entry is replaced by fresh metadata only; no runtime is launched.
    /// Failed persistence leaves the in-memory catalog unchanged.
    fn forget_record(project: &mut Project, session_id: &str) -> io::Result<()> {
        let mut next = project.catalog.clone();
        next.entries.retain(|entry| entry.id != session_id);
        if next.entries.is_empty() {
            Self::add_record(&project.config, &project.store, &mut next, None)?;
        } else {
            if next.selected == session_id {
                next.selected = next.entries[0].id.clone();
            }
            next.save(&project.store)?;
        }
        project.catalog = next;
        Ok(())
    }
    /// Persists both selections before runtime admission. Errors never launch a child.
    fn select(&self, state: &mut State, workspace_id: &str, session_id: &str) -> io::Result<()> {
        let project = state
            .projects
            .get_mut(workspace_id)
            .expect("validated workspace");
        let mut catalog = project.catalog.clone();
        catalog.selected = session_id.into();
        catalog.save(&project.store)?;
        project.catalog = catalog;
        let mut registry = state.registry.clone();
        registry.selected = workspace_id.into();
        registry.save(&self.0.registry_store)?;
        state.registry = registry;
        Ok(())
    }
    /// Stops admission and concurrently awaits all runtime cleanup, independent of browser ownership.
    pub async fn shutdown(&self) -> bool {
        let handles = {
            let mut state = self.0.state.lock().await;
            state.stopping = true;
            state
                .active
                .values()
                .map(|slot| slot.handle.clone())
                .collect::<Vec<_>>()
        };
        let mut jobs = tokio::task::JoinSet::new();
        for handle in handles {
            jobs.spawn(async move { handle.shutdown().await });
        }
        let mut clean = true;
        while let Some(result) = jobs.join_next().await {
            clean &= matches!(result, Ok(true));
        }
        clean
    }
}

/// Projects a canonical UTF-8 folder basename into the 64-byte display-name budget.
fn workspace_name(cwd: &std::path::Path) -> String {
    let name = cwd.file_name().unwrap_or(cwd.as_os_str()).to_string_lossy();
    let mut end = name.len().min(64);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    name[..end].to_owned()
}
