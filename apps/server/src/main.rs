//! Single-process local application: Rust serves static assets and owns Pi lifetimes.
use pi_web::{
    config::{self, Config},
    http::{self, WebState},
    session_manager::SessionManager,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let Some(config) = Config::parse(std::env::args().skip(1))? else {
        println!("{}", config::HELP);
        return Ok(());
    };
    if config.revoke_push {
        pi_web::push::revoke_all(&config.registry_dir.join("push"))?;
        println!("All phone push subscriptions revoked.");
        return Ok(());
    }
    if !config.web_dir.join("index.html").is_file() {
        return Err("frontend build missing; run bun run build first".into());
    }
    let listener =
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port)).await?;
    let port = listener.local_addr()?.port();
    let capability = config::capability()?;
    let (stop, stopping) = tokio::sync::watch::channel(false);
    let browser_origin = config.remote_origin.as_ref().map_or_else(
        || format!("http://127.0.0.1:{port}"),
        |origin| origin.as_str().to_owned(),
    );
    let push = pi_web::push::PushService::start(
        &config.registry_dir.join("push"),
        browser_origin.clone(),
    )?;
    let runtime = SessionManager::start_with_push(config.clone(), Some(push.clone()))?;
    let state = WebState::new(
        runtime.clone(),
        port,
        config.remote_origin,
        capability.clone(),
        config.web_dir,
        stopping.clone(),
    )
    .with_push(push);
    // The secret is only in the fragment: browsers never transmit it in request URLs.
    println!("Open {browser_origin}/#cap={capability}");
    let signal = tokio::spawn(async move {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("signal handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        let _ = stop.send(true);
    });
    let mut closing = stopping.clone();
    let mut requested = stopping;
    let server = async {
        axum::serve(http::BoundedListener::new(listener), http::router(state))
            .with_graceful_shutdown(async move {
                let _ = closing.changed().await;
            })
            .await
    };
    tokio::pin!(server);
    let result = tokio::select! {
        result = &mut server => result,
        _ = requested.changed() => {
            // Agent cleanup cannot wait for an HTTP peer to finish sending a body.
            runtime.shutdown().await;
            match tokio::time::timeout(std::time::Duration::from_secs(3), &mut server).await {
                Ok(result) => result,
                Err(_) => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "HTTP shutdown drain exceeded three seconds")),
            }
        }
    };
    let clean = runtime.shutdown().await;
    signal.abort();
    if !clean {
        return Err("One or more Pi children could not be cleaned up".into());
    }
    result?;
    Ok(())
}
