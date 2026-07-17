// Youdao dictionary lookup for the PDF reader's translate action.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct YoudaoTranslation {
    query: String,
    phonetic: Option<String>,
    explains: Vec<String>,
    page_url: String,
}

#[tauri::command]
pub(crate) async fn translate_with_youdao(query: String) -> Result<YoudaoTranslation, String> {
    let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
    if query.is_empty() {
        return Err("No text selected.".to_string());
    }

    let query = query.chars().take(200).collect::<String>();
    let mut url = reqwest::Url::parse("https://dict.youdao.com/suggest")
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("num", "5")
        .append_pair("ver", "3.0")
        .append_pair("doctype", "json")
        .append_pair("cache", "false")
        .append_pair("le", "en")
        .append_pair("q", &query);

    let response = reqwest::Client::new()
        .get(url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Youdao request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Youdao lookup failed: {}", response.status()));
    }

    let text = response
        .text()
        .await
        .map_err(|error| format!("Failed to read Youdao response: {error}"))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("Failed to parse Youdao response: {error}"))?;

    Ok(parse_youdao_translation(&value, query))
}

fn parse_youdao_translation(value: &serde_json::Value, fallback_query: String) -> YoudaoTranslation {
    let query = value
        .pointer("/data/query")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.pointer("/query").and_then(serde_json::Value::as_str))
        .unwrap_or(&fallback_query)
        .to_string();
    let phonetic = value
        .pointer("/data/phonetic")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.pointer("/basic/phonetic").and_then(serde_json::Value::as_str))
        .map(ToString::to_string);
    let mut explains = Vec::new();

    if let Some(entries) = value.pointer("/data/entries").and_then(serde_json::Value::as_array) {
        for entry in entries {
            if let Some(explain) = entry.get("explain").and_then(serde_json::Value::as_str) {
                push_unique_explain(&mut explains, explain);
            }
        }
    }

    if let Some(basic_explains) = value.pointer("/basic/explains").and_then(serde_json::Value::as_array) {
        for explain in basic_explains {
            if let Some(explain) = explain.as_str() {
                push_unique_explain(&mut explains, explain);
            }
        }
    }

    YoudaoTranslation {
        page_url: build_youdao_page_url(&query),
        query,
        phonetic,
        explains,
    }
}

fn build_youdao_page_url(query: &str) -> String {
    let mut url = reqwest::Url::parse("https://dict.youdao.com/result").expect("static Youdao URL is valid");
    url.query_pairs_mut()
        .append_pair("word", query)
        .append_pair("lang", "en");
    url.to_string()
}

fn push_unique_explain(explains: &mut Vec<String>, value: &str) {
    let explain = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if !explain.is_empty() && !explains.iter().any(|item| item == &explain) {
        explains.push(explain);
    }
}
