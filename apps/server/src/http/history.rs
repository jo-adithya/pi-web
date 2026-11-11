//! Authenticated, bounded reads of conversation-owned history; no arbitrary paths or inference.
use super::*;

pub(super) async fn read(State(state): State<WebState>, Path(session): Path<String>, request: Request<Body>) -> Response {
    fn error(status: StatusCode, message: &str) -> Response {
        (status, axum::Json(serde_json::json!({"error": message}))).into_response()
    }
    if !image_proof(&state, request.headers()) { return error(StatusCode::UNAUTHORIZED, "Capability required"); }
    if request.headers().get(header::CONTENT_TYPE).is_none_or(|value| value != "application/json") {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Expected application/json");
    }
    let Ok(permit) = state.file_slots.clone().try_acquire_owned() else { return error(StatusCode::TOO_MANY_REQUESTS, "History readers are busy"); };
    let body = match tokio::time::timeout(Duration::from_secs(2), to_bytes(request.into_body(), 4096)).await {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => return error(StatusCode::PAYLOAD_TOO_LARGE, "History request is too large"),
        Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "History request timed out"),
    };
    let Ok(input) = serde_json::from_slice::<crate::protocol::HistoryRequest>(&body) else { return error(StatusCode::BAD_REQUEST, "Invalid history request"); };
    let Some(runtime) = state.runtime.lookup(&session).await else { return error(StatusCode::NOT_FOUND, "Open the conversation before reading history"); };
    // The budget follows blocking IO even if the HTTP request or session is cancelled.
    let permit = Arc::new(permit);
    let worker = tokio::spawn(async move {
        let result = runtime.read_history_bounded(input, Some(permit.clone())).await;
        drop(permit);
        result
    });
    match worker.await {
        Ok(Ok(response)) => axum::Json(response).into_response(),
        Ok(Err(message)) => error(StatusCode::UNPROCESSABLE_ENTITY, &message),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "History reader failed"),
    }
}
