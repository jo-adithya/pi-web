//! Server shutdown must not leave Pi lifetime waiting on an incomplete HTTP body.
use std::{fs, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    process::Command,
};

#[tokio::test]
async fn incomplete_http_body_cannot_hold_server_shutdown_forever() {
    let root = std::env::temp_dir().join(format!(
        "pi-web-shutdown-{}",
        pi_web::config::identity().unwrap()
    ));
    fs::create_dir(&root).unwrap();
    fs::write(
        root.join("index.html"),
        "<!doctype html><title>test</title>",
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_pi-web"))
        .args(["--port", "0", "--cwd"])
        .arg(&root)
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--web-dir")
        .arg(&root)
        .arg("--pi")
        .arg(root.join("missing-pi"))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let outcome=async {
        let mut lines=BufReader::new(child.stdout.take().unwrap()).lines();
        let printed=tokio::time::timeout(Duration::from_secs(5),lines.next_line()).await.unwrap().unwrap().unwrap();
        let authority=printed.split("http://").nth(1).unwrap().split('/').next().unwrap();
        let mut stream=TcpStream::connect(authority).await.unwrap();
        let request=format!("POST /auth HTTP/1.1\r\nHost: {authority}\r\nOrigin: http://{authority}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{{");
        stream.write_all(request.as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(unsafe {libc::kill(child.id().unwrap() as i32,libc::SIGTERM)},0);
        tokio::time::timeout(Duration::from_secs(6),child.wait()).await
    }.await;
    if outcome.is_err() {
        child.kill().await.unwrap();
    }
    let _ = child.wait().await;
    fs::remove_dir_all(root).unwrap();
    assert!(
        outcome.is_ok(),
        "incomplete request held graceful shutdown beyond its deadline"
    );
}
