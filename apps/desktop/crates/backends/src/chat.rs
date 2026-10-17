//! Streaming chat completions: `POST /v1/chat/completions`, read as SSE.

use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use shoal_protocol::{FinishReason, InferOptions, ToolCallDelta, Usage};

use crate::http::execute;
use crate::sse::{self, Parser};
use crate::{Error, Finish, Output};

#[derive(Debug, Serialize)]
struct Body<'a> {
    model: &'a str,
    messages: &'a Value,
    stream: bool,
    stream_options: StreamOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<&'a Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<&'a Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<&'a [Value]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<&'a Value>,
}

impl<'a> Body<'a> {
    /// Empty `tools` are left out.
    fn new(model: &'a str, messages: &'a Value, options: &'a InferOptions) -> Self {
        Self {
            model,
            messages,
            stream: true,
            stream_options: StreamOptions { include_usage: true },
            max_tokens: options.max_tokens.as_ref(),
            temperature: options.temperature.as_ref(),
            tools: options.tools.as_deref().filter(|tools| !tools.is_empty()),
            tool_choice: options.tool_choice.as_ref(),
        }
    }
}

#[derive(Debug, Serialize)]
struct StreamOptions {
    include_usage: bool,
}

#[derive(Debug, Default, Deserialize)]
struct Chunk {
    usage: Option<RawUsage>,
    choices: Option<Vec<Choice>>,
}

#[derive(Debug, Deserialize)]
struct RawUsage {
    prompt_tokens: u64,
    completion_tokens: u64,
}

#[derive(Debug, Deserialize)]
struct Choice {
    finish_reason: Option<String>,
    delta: Option<RawDelta>,
}

#[derive(Debug, Deserialize)]
struct RawDelta {
    content: Option<String>,
    reasoning: Option<String>,
    reasoning_content: Option<String>,
    tool_calls: Option<Vec<RawToolCall>>,
}

#[derive(Debug, Deserialize)]
struct RawToolCall {
    index: u32,
    id: Option<String>,
    function: Option<RawFunction>,
}

#[derive(Debug, Deserialize)]
struct RawFunction {
    name: Option<String>,
    arguments: Option<String>,
}

pub(crate) async fn run(
    client: &Client,
    url: &str,
    model: &str,
    input: &Value,
    options: &InferOptions,
    mut emit: impl FnMut(Output),
) -> Result<Finish, Error> {
    let body = Body::new(model, input, options);
    let request = client.post(format!("{url}/v1/chat/completions")).json(&body);
    let mut body = execute(client, request).await?.bytes_stream();
    let mut parser = Parser::default();
    let mut events = Vec::new();
    let mut finish = Finish::STOP;
    while let Some(chunk) = body.next().await {
        let chunk =
            chunk.map_err(|error| Error::Backend(format!("Chat stream failed: {error}")))?;
        parser.push(&chunk, &mut events).map_err(|sse::TooLarge| {
            Error::Backend("Chat stream failed: an SSE event exceeded 10 MiB".into())
        })?;
        for event in events.drain(..) {
            let data = match event {
                sse::Event::Retry => {
                    return Err(Error::Backend(
                        "Chat stream ended with an SSE retry directive".into(),
                    ));
                }
                sse::Event::Data(data) if data == "[DONE]" => continue,
                sse::Event::Data(data) => data,
            };
            match serde_json::from_str::<Chunk>(&data) {
                // Chunks carry generated text, so only the error is logged.
                Err(error) => {
                    tracing::warn!(backend = url, "skipping malformed chat chunk: {error}");
                }
                Ok(chunk) => {
                    if let Some(output) = apply(chunk, &mut finish) {
                        emit(output);
                    }
                }
            }
        }
    }
    Ok(finish)
}

/// Folds a chunk's usage and finish reason into `finish` and returns its
/// delta, if it has anything to say. Only the first choice is read.
fn apply(chunk: Chunk, finish: &mut Finish) -> Option<Output> {
    if let Some(usage) = chunk.usage {
        finish.usage = Some(Usage {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
        });
    }
    let choice = chunk.choices?.into_iter().next()?;
    match choice.finish_reason.as_deref() {
        Some("stop") => finish.reason = FinishReason::Stop,
        Some("length") => finish.reason = FinishReason::Length,
        Some("tool_calls") => finish.reason = FinishReason::ToolCalls,
        _ => {}
    }
    let delta = choice.delta?;
    let present = |text: Option<String>| text.filter(|s| !s.is_empty());
    let content = present(delta.content);
    let reasoning = present(delta.reasoning).or_else(|| present(delta.reasoning_content));
    let tool_calls = delta.tool_calls.filter(|calls| !calls.is_empty()).map(|calls| {
        calls
            .into_iter()
            .map(|call| {
                let (name, arguments) =
                    call.function.map_or((None, None), |f| (f.name, f.arguments));
                ToolCallDelta { index: call.index, id: call.id, name, arguments }
            })
            .collect()
    });
    (content.is_some() || reasoning.is_some() || tool_calls.is_some()).then_some(Output::Delta {
        content,
        tool_calls,
        reasoning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chunk(value: Value) -> Chunk {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn deltas_come_from_the_first_choice_only() {
        let mut finish = Finish::STOP;
        let output = apply(
            chunk(json!({ "choices": [
                { "delta": { "content": "Hi", "reasoning": "", "reasoning_content": "hm",
                  "tool_calls": [{ "index": 0, "id": "c1", "function": { "name": "f", "arguments": "" } }] } },
                { "delta": { "content": "ignored" } },
            ]})),
            &mut finish,
        );
        assert_eq!(
            output,
            Some(Output::Delta {
                content: Some("Hi".into()),
                reasoning: Some("hm".into()),
                tool_calls: Some(vec![ToolCallDelta {
                    index: 0,
                    id: Some("c1".into()),
                    name: Some("f".into()),
                    arguments: Some(String::new()),
                }]),
            })
        );
    }

    #[test]
    fn role_only_chunks_say_nothing_and_the_last_finish_and_usage_win() {
        let mut finish = Finish::STOP;
        let role = json!({ "choices": [{ "delta": { "role": "assistant", "content": "" } }] });
        assert_eq!(apply(chunk(role), &mut finish), None);

        apply(
            chunk(json!({ "choices": [{ "finish_reason": "length", "delta": {} }] })),
            &mut finish,
        );
        apply(chunk(json!({ "choices": [{ "finish_reason": "content_filter" }] })), &mut finish);
        apply(
            chunk(
                json!({ "choices": [], "usage": { "prompt_tokens": 3, "completion_tokens": 4 } }),
            ),
            &mut finish,
        );
        assert_eq!(
            finish,
            Finish {
                reason: FinishReason::Length,
                usage: Some(Usage { prompt_tokens: 3, completion_tokens: 4 }),
            }
        );
    }

    #[test]
    fn empty_tools_are_omitted_and_null_and_numbers_pass_through_unchanged() {
        let options: InferOptions = serde_json::from_value(json!({
            "maxTokens": 5, "temperature": 0.7, "tools": [], "toolChoice": null
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_string(&Body::new("m", &json!([]), &options)).unwrap(),
            r#"{"model":"m","messages":[],"stream":true,"stream_options":{"include_usage":true},"max_tokens":5,"temperature":0.7,"tool_choice":null}"#
        );
    }
}
