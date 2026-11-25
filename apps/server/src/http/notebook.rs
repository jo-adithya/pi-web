//! Authenticated review persistence uses the workspace's existing private metadata ownership.
use super::*;

/// Imports only explicit source identities after the same origin/capability and admission checks as local review.
pub(super) async fn review_source(State(state): State<WebState>, Path(session): Path<String>, request: Request<Body>) -> Response {
    let error = |status: StatusCode, message: &str| (status, axum::Json(serde_json::json!({"error":message}))).into_response();
    if !image_proof(&state, request.headers()) { return error(StatusCode::UNAUTHORIZED, "Capability required"); }
    if request.headers().get(header::CONTENT_TYPE).is_none_or(|v| v != "application/json") { return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Expected application/json"); }
    let Some(root) = state.runtime.workspace_directory(&session).await else { return error(StatusCode::NOT_FOUND, "Session workspace not found"); };
    let Ok(permit) = state.review_slots.clone().try_acquire_owned() else { return error(StatusCode::TOO_MANY_REQUESTS, "Review workers are busy"); };
    let body = match tokio::time::timeout(Duration::from_secs(2), to_bytes(request.into_body(), 2048)).await {
        Ok(Ok(body)) => body,
        _ => return error(StatusCode::PAYLOAD_TOO_LARGE, "Source request exceeds its limits"),
    };
    let Ok(input) = serde_json::from_slice::<crate::review_sources::Request>(&body) else { return error(StatusCode::BAD_REQUEST, "Invalid source request"); };
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        let _permit = permit;
        match input {
            crate::review_sources::Request::Preferences { enabled } => state.runtime.author_notes(&session, enabled).await.map(|enabled| serde_json::json!({"enabled":enabled})),
            crate::review_sources::Request::Author { automatic: true } => match state.runtime.lookup(&session).await {
                Some(handle) => handle.author_notes.read(&root).await,
                None => Err("Open this conversation to validate its saved author-note provenance"),
            },
            input => crate::review_sources::import(&root, &session, input, cancelled).await,
        }
    });
    let result = worker.await;
    drop(cancel);
    match result {
        Ok(Ok(value)) => axum::Json(value).into_response(),
        Ok(Err(message)) => error(StatusCode::UNPROCESSABLE_ENTITY, message),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Source import failed"),
    }
}

pub(super) async fn review_notebook(State(state): State<WebState>, Path(session): Path<String>, request: Request<Body>) -> Response {
    let error = |status: StatusCode, message: &str| (status, axum::Json(serde_json::json!({"error":message}))).into_response();
    if !image_proof(&state, request.headers()) { return error(StatusCode::UNAUTHORIZED, "Capability required"); }
    if request.headers().get(header::CONTENT_TYPE).is_none_or(|v| v != "application/json") { return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Expected application/json"); }
    if state.runtime.workspace_directory(&session).await.is_none() { return error(StatusCode::NOT_FOUND, "Session workspace not found"); }
    let Ok(permit) = state.review_slots.clone().try_acquire_owned() else { return error(StatusCode::TOO_MANY_REQUESTS, "Review workers are busy"); };
    let body = match tokio::time::timeout(Duration::from_secs(5), to_bytes(request.into_body(), crate::review_notebook::MAX_BYTES + 1024)).await {
        Ok(Ok(body)) => body,
        _ => return error(StatusCode::PAYLOAD_TOO_LARGE, "Review request exceeds its time or 16 MiB size limit"),
    };
    let Ok(input) = serde_json::from_slice::<crate::review_notebook::Request>(&body) else { return error(StatusCode::BAD_REQUEST, "Invalid review document"); };
    let worker = tokio::spawn(async move {
        let _permit = permit;
        state.runtime.review_notebook(session, input).await
    });
    match worker.await {
        Ok(Ok(document)) => axum::Json(document).into_response(),
        Ok(Err((message, code))) => error(StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), message),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Review storage worker failed"),
    }
}
