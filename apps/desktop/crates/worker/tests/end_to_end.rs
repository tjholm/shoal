//! A real [`Worker`] against a fake shoal server and a fake OpenAI-compatible
//! backend, checked against `docs/worker-protocol.md`.

use std::future::Future;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use shoal_worker::{Availability, Config, Connection, Outcome, State, Token, Worker};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, timeout, timeout_at};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

/// How long to wait for something that should happen.
const WAIT: Duration = Duration::from_secs(5);
/// How long nothing must happen to count as "nothing happens".
const QUIET: Duration = Duration::from_millis(300);
/// Longer than the first reconnect delay (1 s), so a reconnect would show.
const BEYOND_BACKOFF: Duration = Duration::from_millis(1500);
/// Has every character class `encodeURIComponent` treats differently.
const TOKEN: &str = "a b+c/!*ü";
const ENCODED_TOKEN: &str = "a%20b%2Bc%2F!*%C3%BC";

/// Every model the fake backend lists, in its order.
const MODELS: [&str; 6] = ["m1", "slow", "broken", "e1", "img", "tts"];

async fn within<T>(future: impl Future<Output = T>) -> T {
    timeout(WAIT, future).await.expect("timed out")
}

// The fake shoal server.

struct Server {
    url: String,
    listener: TcpListener,
}

impl Server {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws/workers", listener.local_addr().unwrap());
        Self { url, listener }
    }

    /// The worker's next connection, and the path and query it asked for.
    async fn accept(&self) -> (Conn, String) {
        let (stream, _) = within(self.listener.accept()).await.unwrap();
        let mut uri = String::new();
        #[allow(clippy::result_large_err, reason = "the callback type is tungstenite's")]
        let record = |request: &Request, response: Response| {
            uri = request.uri().to_string();
            Ok(response)
        };
        let socket = tokio_tungstenite::accept_hdr_async(stream, record).await.unwrap();
        (Conn(socket), uri)
    }

    /// Fails if the worker connects within `wait`.
    async fn assert_no_connection(&self, wait: Duration) {
        assert!(timeout(wait, self.listener.accept()).await.is_err(), "the worker reconnected");
    }
}

/// One worker connection, from the server's side.
struct Conn(WebSocketStream<TcpStream>);

impl Conn {
    /// The next message other than a `models` or `stats` report, which the
    /// worker sends on its own schedule.
    async fn recv(&mut self) -> String {
        self.next_message(Instant::now() + WAIT).await.expect("timed out waiting for a message")
    }

    /// The next frame, reports included.
    async fn frame(&mut self) -> String {
        self.next_frame(Instant::now() + WAIT).await.expect("timed out waiting for a frame")
    }

    async fn next_message(&mut self, deadline: Instant) -> Option<String> {
        loop {
            let frame = self.next_frame(deadline).await?;
            if !frame.starts_with(r#"{"type":"models""#) && !frame.starts_with(r#"{"type":"stats""#)
            {
                return Some(frame);
            }
        }
    }

    /// The next text frame, verbatim so key order is checked.
    async fn next_frame(&mut self, deadline: Instant) -> Option<String> {
        loop {
            match timeout_at(deadline, self.0.next()).await.ok()? {
                Some(Ok(Message::Text(text))) => return Some(text.to_string()),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                other => panic!("expected a text frame, got {other:?}"),
            }
        }
    }

    async fn recv_json(&mut self) -> Value {
        serde_json::from_str(&self.recv().await).unwrap()
    }

    /// Sends `frame` verbatim; `json!` would reorder its keys.
    async fn send(&mut self, frame: &str) {
        self.0.send(Message::text(frame)).await.unwrap();
    }

    async fn close(&mut self, code: u16, reason: &str) {
        let frame = CloseFrame { code: code.into(), reason: reason.into() };
        self.0.close(Some(frame)).await.unwrap();
    }

    /// Fails if the worker sends anything but reports within [`QUIET`].
    async fn assert_quiet(&mut self) {
        if let Some(message) = self.next_message(Instant::now() + QUIET).await {
            panic!("expected silence, got {message}");
        }
    }

    /// Waits for the worker to close the socket, returning its close frame.
    async fn closed(&mut self) -> Option<CloseFrame> {
        loop {
            match within(self.0.next()).await {
                Some(Ok(Message::Close(frame))) => return frame,
                None | Some(Err(_)) => return None,
                Some(Ok(_)) => {}
            }
        }
    }
}

// The fake backend: vLLM-style, so discovery is a single `GET /v1/models`
// and every listed model counts as loaded.

struct Backend {
    url: String,
    requests: mpsc::UnboundedReceiver<HttpRequest>,
    /// One message each time a client hangs up on a held-open response.
    hangups: mpsc::UnboundedReceiver<()>,
}

#[derive(Debug)]
struct HttpRequest {
    path: String,
    body: String,
}

enum Reply {
    Ok {
        content_type: Option<&'static str>,
        body: Vec<u8>,
    },
    Status(u16, &'static str),
    /// Streams one SSE event, then holds the response open until the client
    /// hangs up.
    Hang(&'static str),
}

impl Backend {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (requests_tx, requests) = mpsc::unbounded_channel();
        let (hangups_tx, hangups) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                tokio::spawn(serve_http(stream, requests_tx.clone(), hangups_tx.clone()));
            }
        });
        Self { url, requests, hangups }
    }

    /// The next request other than a discovery probe.
    async fn job_request(&mut self) -> HttpRequest {
        loop {
            let request = within(self.requests.recv()).await.unwrap();
            if request.path != "/v1/models" {
                return request;
            }
        }
    }

    async fn hung_up(&mut self) {
        within(self.hangups.recv()).await.unwrap();
    }
}

/// Answers one request, then closes the connection.
async fn serve_http(
    stream: TcpStream,
    requests: mpsc::UnboundedSender<HttpRequest>,
    hangups: mpsc::UnboundedSender<()>,
) {
    let mut reader = BufReader::new(stream);
    let Some(request) = read_request(&mut reader).await else { return };
    let reply = respond(&request);
    requests.send(request).unwrap();
    let mut stream = reader.into_inner();
    let (status, content_type, body) = match reply {
        Reply::Ok { content_type, body } => (200, content_type, body),
        Reply::Status(status, body) => (status, Some("text/plain"), body.into()),
        Reply::Hang(event) => {
            let head =
                "HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-type: text/event-stream\r\n\r\n";
            stream.write_all(format!("{head}{event}").as_bytes()).await.unwrap();
            while stream.read(&mut [0; 64]).await.is_ok_and(|read| read > 0) {}
            hangups.send(()).unwrap();
            return;
        }
    };
    let content_type = content_type.map(|t| format!("content-type: {t}\r\n")).unwrap_or_default();
    let head = format!(
        "HTTP/1.1 {status} X\r\nconnection: close\r\ncontent-length: {}\r\n{content_type}\r\n",
        body.len()
    );
    let _ = stream.write_all(&[head.as_bytes(), &body].concat()).await;
}

async fn read_request(reader: &mut BufReader<TcpStream>) -> Option<HttpRequest> {
    let mut line = String::new();
    reader.read_line(&mut line).await.ok()?;
    let path = line.split(' ').nth(1)?.to_owned();
    let mut length = 0;
    loop {
        line.clear();
        reader.read_line(&mut line).await.ok()?;
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse().ok()?;
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await.ok()?;
    Some(HttpRequest { path, body: String::from_utf8(body).ok()? })
}

/// SSE for model `m1`: a role-only chunk, reasoning, content with a tool
/// call, a malformed chunk, `[DONE]`, and then (since `[DONE]` doesn't end
/// the stream) the finish reason and usage.
const CHAT_STREAM: &str = concat!(
    "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hm\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\",\"tool_calls\":[{\"index\":0,\"id\":\"c1\",",
    "\"function\":{\"name\":\"f\",\"arguments\":\"{\\\"a\"}}]}}]}\n\n",
    "data: not json\n\n",
    "data: [DONE]\n\n",
    "data: {\"choices\":[{\"finish_reason\":\"tool_calls\",\"delta\":{}}],",
    "\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4}}\n\n",
);

fn respond(request: &HttpRequest) -> Reply {
    let json = |value: Value| Reply::Ok {
        content_type: Some("application/json"),
        body: value.to_string().into_bytes(),
    };
    let body: Value = serde_json::from_str(&request.body).unwrap_or_default();
    match (request.path.as_str(), body["model"].as_str()) {
        ("/v1/models", _) => json(json!({
            "data": MODELS.map(|id| json!({ "id": id, "owned_by": "vllm" }))
        })),
        ("/v1/chat/completions", Some("slow")) => {
            Reply::Hang("data: {\"choices\":[{\"delta\":{\"content\":\"thinking\"}}]}\n\n")
        }
        ("/v1/chat/completions", Some("broken")) => Reply::Status(503, "overloaded"),
        ("/v1/chat/completions", _) => {
            Reply::Ok { content_type: Some("text/event-stream"), body: CHAT_STREAM.into() }
        }
        ("/v1/embeddings", _) => {
            json(json!({ "data": [{ "embedding": [0.5, -1.25] }, { "embedding": [2.5] }] }))
        }
        ("/v1/images/generations", _) => {
            json(json!({ "data": [{ "b64_json": "AAA", "revised_prompt": "a cute cat" }] }))
        }
        ("/v1/audio/speech", _) => {
            Reply::Ok { content_type: Some("audio/wav; codecs=1"), body: vec![1, 2, 3] }
        }
        _ => Reply::Status(404, "not found"),
    }
}

// The worker under test.

struct Harness {
    server: Server,
    backend: Backend,
    worker: Worker,
    state: watch::Receiver<State>,
    identities: TempDir,
}

impl Harness {
    async fn start() -> Self {
        Self::start_with_stored_identity(None).await
    }

    /// Starts the worker with `identity` already in its identity file.
    async fn start_with_stored_identity(identity: Option<&str>) -> Self {
        let server = Server::start().await;
        let backend = Backend::start().await;
        let identities = TempDir::new().unwrap();
        let path = identity_path(&identities, &server);
        if let Some(identity) = identity {
            std::fs::write(path, identity).unwrap();
        }
        let config = Config {
            server: server.url.clone(),
            token: Token::new(TOKEN.into()),
            backends: vec![backend.url.clone()],
            max_concurrent: NonZeroU32::new(2).unwrap(),
            name: Some("gpu-box".into()),
        };
        let worker = Worker::start_with_identity_dir(
            identities.path().to_owned(),
            Some(config),
            Availability::On,
        );
        let state = worker.subscribe();
        Self { server, backend, worker, state, identities }
    }

    fn identity_path(&self) -> PathBuf {
        identity_path(&self.identities, &self.server)
    }

    /// Accepts the worker as new and reads its first report.
    async fn online(&mut self) -> Conn {
        let (mut conn, _) = self.server.accept().await;
        assert_eq!(conn.recv_json().await["type"], "register_new");
        conn.send(r#"{"type":"registered","workerId":"w-1","secret":"s-1"}"#).await;
        expect_report(&mut conn).await;
        conn
    }

    async fn wait_for(&mut self, test: impl FnMut(&State) -> bool) {
        within(self.state.wait_for(test)).await.unwrap();
    }
}

/// Where the worker keeps its identity for `server`.
fn identity_path(identities: &TempDir, server: &Server) -> PathBuf {
    let hash = hex::encode(Sha256::digest(server.url.as_bytes()));
    identities.path().join(format!("identity-{}.json", &hash[..16]))
}

/// `models` then `stats`, from the same probe.
async fn expect_report(conn: &mut Conn) {
    // `json!` would sort the keys, so the expected frames are built as text.
    let models = MODELS.map(|id| format!(r#"{{"id":"{id}"}}"#)).join(",");
    assert_eq!(conn.frame().await, format!(r#"{{"type":"models","models":[{models}]}}"#));
    let stats = conn.frame().await;
    let loaded = serde_json::to_string(&MODELS).unwrap();
    let prefix =
        format!(r#"{{"type":"stats","loadedModels":{loaded},"jobsCompleted":0,"uptimeMs":"#);
    assert!(stats.starts_with(&prefix), "{stats}");
}

/// An `infer` frame; `input` and `options` are JSON.
fn infer(job_id: &str, task: &str, model: &str, input: &str, options: &str) -> String {
    format!(
        r#"{{"type":"infer","jobId":"{job_id}","task":"{task}","model":"{model}","input":{input},"options":{options}}}"#
    )
}

// Connection and registration.

#[tokio::test]
async fn registers_as_new_saves_the_identity_and_reports() {
    let mut harness = Harness::start().await;
    let (mut conn, uri) = harness.server.accept().await;
    assert_eq!(uri, format!("/ws/workers?token={ENCODED_TOKEN}"));
    assert_eq!(conn.recv().await, r#"{"type":"register_new","maxConcurrent":2,"name":"gpu-box"}"#);
    assert!(!harness.identity_path().exists());

    conn.send(r#"{"type":"registered","workerId":"w-1","secret":"s-1"}"#).await;
    expect_report(&mut conn).await;
    assert_eq!(
        std::fs::read_to_string(harness.identity_path()).unwrap(),
        "{\n  \"workerId\": \"w-1\",\n  \"secret\": \"s-1\"\n}"
    );
    harness.wait_for(|s| s.connection == Connection::Online { worker_id: "w-1".into() }).await;
}

#[tokio::test]
async fn each_probe_is_reported_once() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    assert_eq!(conn.next_frame(Instant::now() + QUIET).await, None);
}

#[tokio::test]
async fn reconnects_by_resuming_with_the_saved_identity() {
    let mut harness = Harness::start().await;
    let conn = harness.online().await;
    drop(conn);

    let (mut conn, _) = harness.server.accept().await;
    assert_eq!(
        conn.recv().await,
        r#"{"type":"register_resume","workerId":"w-1","secret":"s-1","maxConcurrent":2,"name":"gpu-box"}"#
    );
    conn.send(r#"{"type":"registered","workerId":"w-1"}"#).await;
    expect_report(&mut conn).await;
}

#[tokio::test]
async fn resumes_an_identity_stored_by_the_typescript_cli() {
    let stored = "{\n  \"workerId\": \"w-9\",\n  \"secret\": \"s-9\"\n}";
    let harness = Harness::start_with_stored_identity(Some(stored)).await;
    let (mut conn, _) = harness.server.accept().await;
    assert_eq!(
        conn.recv().await,
        r#"{"type":"register_resume","workerId":"w-9","secret":"s-9","maxConcurrent":2,"name":"gpu-box"}"#
    );
}

#[tokio::test]
async fn answers_ping_with_pong() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    conn.send(r#"{"type":"ping"}"#).await;
    assert_eq!(conn.recv().await, r#"{"type":"pong"}"#);
}

#[tokio::test]
async fn halts_when_the_token_is_rejected() {
    let mut harness = Harness::start().await;
    let (mut conn, _) = harness.server.accept().await;
    conn.recv().await;
    conn.close(1008, "invalid api key").await;

    harness.wait_for(|s| matches!(s.connection, Connection::Halted { .. })).await;
    harness.server.assert_no_connection(BEYOND_BACKOFF).await;
}

#[tokio::test]
async fn retries_when_the_server_still_holds_the_old_connection() {
    let mut harness = Harness::start().await;
    let (mut conn, _) = harness.server.accept().await;
    conn.recv().await;
    conn.close(1008, "worker already connected").await;

    harness.wait_for(|s| matches!(s.connection, Connection::Retrying { .. })).await;
    let (mut conn, _) = harness.server.accept().await;
    assert_eq!(conn.recv_json().await["type"], "register_new");
}

// Jobs.

#[tokio::test]
async fn streams_a_chat_job() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    let options =
        r#"{"maxTokens":5,"temperature":0.7,"tools":[{"type":"function"}],"toolChoice":"auto"}"#;
    // Keys in sorted order: see `passes_chat_messages_through_verbatim`.
    conn.send(&infer("j1", "chat", "m1", r#"[{"content":"hi","role":"user"}]"#, options)).await;

    assert_eq!(conn.recv().await, r#"{"type":"model_ready","jobId":"j1","model":"m1"}"#);
    assert_eq!(conn.recv().await, r#"{"type":"delta","jobId":"j1","reasoning":"hm"}"#);
    assert_eq!(
        conn.recv().await,
        r#"{"type":"delta","jobId":"j1","content":"Hi","toolCalls":[{"index":0,"id":"c1","name":"f","arguments":"{\"a"}]}"#
    );
    assert_eq!(
        conn.recv().await,
        r#"{"type":"done","jobId":"j1","finishReason":"tool_calls","usage":{"promptTokens":3,"completionTokens":4}}"#
    );
    assert_eq!(
        harness.backend.job_request().await.body,
        r#"{"model":"m1","messages":[{"content":"hi","role":"user"}],"stream":true,"stream_options":{"include_usage":true},"max_tokens":5,"temperature":0.7,"tools":[{"type":"function"}],"tool_choice":"auto"}"#
    );
    harness.wait_for(|s| s.jobs_completed == 1 && s.jobs.is_empty()).await;
    let state = harness.state.borrow().clone();
    assert_eq!((state.tokens_out, &state.recent[0].outcome), (4, &Outcome::Done));
}

#[tokio::test]
async fn sends_a_null_tool_choice() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    conn.send(&infer("j1", "chat", "m1", "[]", r#"{"toolChoice":null}"#)).await;
    assert!(harness.backend.job_request().await.body.ends_with(r#""tool_choice":null}"#));
}

#[tokio::test]
async fn passes_chat_messages_through_verbatim() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    let messages = r#"[{"role":"user","content":"hi"}]"#;
    conn.send(&infer("j1", "chat", "m1", messages, "{}")).await;
    let body = harness.backend.job_request().await.body;
    assert!(body.contains(&format!(r#""messages":{messages},"#)), "{body}");
}

#[tokio::test]
async fn runs_an_embedding_job() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    conn.send(&infer("j2", "embedding", "e1", r#"["a","b"]"#, "{}")).await;

    assert_eq!(conn.recv().await, r#"{"type":"model_ready","jobId":"j2","model":"e1"}"#);
    assert_eq!(conn.recv().await, r#"{"type":"embedding","jobId":"j2","vector":[0.5,-1.25]}"#);
    assert_eq!(conn.recv().await, r#"{"type":"done","jobId":"j2","finishReason":"stop"}"#);
    let body: Value = serde_json::from_str(&harness.backend.job_request().await.body).unwrap();
    assert_eq!(body, json!({ "model": "e1", "input": ["a", "b"] }));
}

#[tokio::test]
async fn sends_embedding_keys_in_typescript_order() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    conn.send(&infer("j2", "embedding", "e1", r#""a""#, "{}")).await;
    assert_eq!(harness.backend.job_request().await.body, r#"{"model":"e1","input":"a"}"#);
}

#[tokio::test]
async fn runs_an_image_job() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    let options = r#"{"image":{"size":"256x256","n":1,"responseFormat":"b64_json"}}"#;
    conn.send(&infer("j3", "image", "img", r#""a cat""#, options)).await;

    assert_eq!(conn.recv().await, r#"{"type":"model_ready","jobId":"j3","model":"img"}"#);
    assert_eq!(
        conn.recv().await,
        r#"{"type":"image","jobId":"j3","images":[{"b64":"AAA","revisedPrompt":"a cute cat"}]}"#
    );
    assert_eq!(conn.recv().await, r#"{"type":"done","jobId":"j3","finishReason":"stop"}"#);
    assert_eq!(
        harness.backend.job_request().await.body,
        r#"{"model":"img","prompt":"a cat","size":"256x256","n":1,"response_format":"b64_json"}"#
    );
}

#[tokio::test]
async fn runs_a_tts_job() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    let options = r#"{"tts":{"voice":"af","responseFormat":"mp3","speed":1.5}}"#;
    conn.send(&infer("j4", "tts", "tts", r#""hello""#, options)).await;

    assert_eq!(conn.recv().await, r#"{"type":"model_ready","jobId":"j4","model":"tts"}"#);
    // The Content-Type wins over the requested format, parameters and all.
    assert_eq!(
        conn.recv().await,
        r#"{"type":"audio","jobId":"j4","b64":"AQID","mimeType":"audio/wav; codecs=1"}"#
    );
    assert_eq!(conn.recv().await, r#"{"type":"done","jobId":"j4","finishReason":"stop"}"#);
    assert_eq!(
        harness.backend.job_request().await.body,
        r#"{"model":"tts","input":"hello","voice":"af","response_format":"mp3","speed":1.5}"#
    );
}

#[tokio::test]
async fn reports_a_model_no_backend_serves() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    conn.send(&infer("j5", "chat", "nope", "[]", "{}")).await;

    assert_eq!(conn.recv().await, r#"{"type":"model_ready","jobId":"j5","model":"nope"}"#);
    let message =
        format!("No configured backend serves model \"nope\". Known models: {}", MODELS.join(", "));
    assert_eq!(
        conn.recv().await,
        format!(r#"{{"type":"error","jobId":"j5","message":{}}}"#, json!(message))
    );
    conn.assert_quiet().await;
}

#[tokio::test]
async fn reports_a_backend_error_without_done() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    conn.send(&infer("j6", "chat", "broken", "[]", "{}")).await;

    assert_eq!(conn.recv().await, r#"{"type":"model_ready","jobId":"j6","model":"broken"}"#);
    assert_eq!(
        conn.recv().await,
        r#"{"type":"error","jobId":"j6","message":"Backend returned 503: overloaded"}"#
    );
    conn.assert_quiet().await;
    harness.wait_for(|s| s.jobs.is_empty()).await;
    assert_eq!(harness.state.borrow().jobs_completed, 0);
    assert_eq!(
        harness.state.borrow().recent[0].outcome,
        Outcome::Failed("Backend returned 503: overloaded".into())
    );
}

#[tokio::test]
async fn cancel_aborts_the_backend_request_silently() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    conn.send(&infer("j7", "chat", "slow", "[]", "{}")).await;
    assert_eq!(conn.recv().await, r#"{"type":"model_ready","jobId":"j7","model":"slow"}"#);
    assert_eq!(conn.recv().await, r#"{"type":"delta","jobId":"j7","content":"thinking"}"#);
    harness.wait_for(|s| s.jobs.len() == 1).await;

    conn.send(r#"{"type":"cancel","jobId":"j7"}"#).await;
    harness.backend.hung_up().await;
    conn.assert_quiet().await;
    harness.wait_for(|s| s.jobs.is_empty()).await;
    assert_eq!(harness.state.borrow().recent[0].outcome, Outcome::Cancelled);
}

#[tokio::test]
async fn switching_off_disconnects_and_drops_running_jobs() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    conn.send(&infer("j8", "chat", "slow", "[]", "{}")).await;
    assert_eq!(conn.recv().await, r#"{"type":"model_ready","jobId":"j8","model":"slow"}"#);
    assert_eq!(conn.recv().await, r#"{"type":"delta","jobId":"j8","content":"thinking"}"#);
    harness.wait_for(|s| s.jobs.len() == 1).await;

    harness.worker.set_availability(Availability::Off);
    let close = conn.closed().await.expect("a close frame");
    assert_eq!(u16::from(close.code), 1000);
    harness.backend.hung_up().await;
    harness.wait_for(|s| s.connection == Connection::Offline && s.jobs.is_empty()).await;
    assert_eq!(harness.state.borrow().recent[0].outcome, Outcome::Abandoned);
    harness.server.assert_no_connection(BEYOND_BACKOFF).await;
}

/// The TypeScript worker ignores these, leaving the server's job hanging.
#[tokio::test]
async fn answers_an_unreadable_job_with_an_error() {
    let mut harness = Harness::start().await;
    let mut conn = harness.online().await;
    conn.send(&infer("j9", "video", "m1", r#""x""#, "{}")).await;

    let reply = conn.recv_json().await;
    assert_eq!((&reply["type"], &reply["jobId"]), (&json!("error"), &json!("j9")));
    assert!(reply["message"].as_str().unwrap().starts_with("Invalid job: "), "{reply}");
}
