//! Bounded TCP ownership before HTTP parsing, including incomplete headers and upgrades.
use axum::serve::Listener;
use std::{
    future::Future,
    io,
    net::SocketAddr,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{Instant, Sleep},
};

const IDLE: Duration = Duration::from_secs(10);

/// Retains at most 64 accepted connections, including upgraded WebSockets.
/// Excess connections close immediately; inactive streams expire after ten seconds.
pub struct BoundedListener {
    inner: TcpListener,
    slots: Arc<Semaphore>,
}
impl BoundedListener {
    pub fn new(inner: TcpListener) -> Self {
        Self {
            inner,
            slots: Arc::new(Semaphore::new(64)),
        }
    }
}
impl Listener for BoundedListener {
    type Io = Connection;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (Connection, SocketAddr) {
        loop {
            let (inner, address) = Listener::accept(&mut self.inner).await;
            let Ok(permit) = self.slots.clone().try_acquire_owned() else {
                drop(inner);
                continue;
            };
            return (
                Connection {
                    inner,
                    _permit: permit,
                    deadline: Box::pin(tokio::time::sleep(IDLE)),
                },
                address,
            );
        }
    }
    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.inner.local_addr()
    }
}
/// Keeps its admission permit through the complete HTTP/upgrade I/O lifetime.
pub struct Connection {
    inner: TcpStream,
    _permit: OwnedSemaphorePermit,
    deadline: Pin<Box<Sleep>>,
}
impl Connection {
    fn expired(&mut self, cx: &mut Context<'_>) -> bool {
        self.deadline.as_mut().poll(cx).is_ready()
    }
    fn progress(&mut self) {
        self.deadline.as_mut().reset(Instant::now() + IDLE);
    }
}
impl AsyncRead for Connection {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.expired(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        let before = buffer.filled().len();
        let result = Pin::new(&mut this.inner).poll_read(cx, buffer);
        if matches!(result, Poll::Ready(Ok(()))) && buffer.filled().len() > before {
            this.progress();
        }
        result
    }
}
impl AsyncWrite for Connection {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.expired(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        let result = Pin::new(&mut this.inner).poll_write(cx, bytes);
        if matches!(result, Poll::Ready(Ok(count)) if count > 0) {
            this.progress();
        }
        result
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.expired(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        Pin::new(&mut this.inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn capacity_lasts_until_io_drops_and_excess_connections_close() {
        let inner = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = inner.local_addr().unwrap();
        let mut listener = BoundedListener {
            inner,
            slots: Arc::new(Semaphore::new(1)),
        };
        let _first_client = TcpStream::connect(address).await.unwrap();
        let (first, _) = listener.accept().await;
        let mut rejected = TcpStream::connect(address).await.unwrap();
        let accepting = tokio::spawn(async move { listener.accept().await });
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), rejected.read(&mut [0]))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        drop(first);
        let _next_client = TcpStream::connect(address).await.unwrap();
        let (mut next, _) = tokio::time::timeout(Duration::from_secs(1), accepting)
            .await
            .unwrap()
            .unwrap();
        // Shorten the same production timer instead of making the test wait ten seconds.
        next.deadline
            .as_mut()
            .reset(Instant::now() + Duration::from_millis(10));
        assert_eq!(
            next.read(&mut [0]).await.unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }
}
