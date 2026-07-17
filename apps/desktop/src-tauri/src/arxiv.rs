// arXiv integration: title search over the Atom API, version-pinned PDF
// downloads with progress events, and the feed/text parsing helpers.

use tauri::AppHandle;

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum ArxivDownloadEvent {
    Started { total_bytes: Option<u64> },
    Progress { downloaded_bytes: u64, total_bytes: Option<u64> },
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArxivAuthor {
    full_name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArxivMetadata {
    arxiv_id: String,
    title: String,
    authors: Vec<ArxivAuthor>,
    year: Option<i32>,
    #[serde(rename = "abstract")]
    abstract_: String,
    doi: Option<String>,
    url: String,
    published_at: Option<String>,
    updated_at: Option<String>,
    venue: String,
    categories: Vec<String>,
    score: f64,
}

#[tauri::command]
pub(crate) async fn search_arxiv_by_title(app: AppHandle, title: String) -> Result<Vec<ArxivMetadata>, String> {
    let query = title.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let mut url = reqwest::Url::parse("https://export.arxiv.org/api/query")
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("search_query", &format!("ti:\"{}\"", query.replace('"', "")))
        .append_pair("start", "0")
        .append_pair("max_results", "3")
        .append_pair("sortBy", "relevance")
        .append_pair("sortOrder", "descending");

    let response = crate::proxy::network_client(&app)?
        .get(url)
        .header("accept", "application/atom+xml")
        .send()
        .await
        .map_err(|error| format!("arXiv request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("arXiv lookup failed: {}", response.status()));
    }

    let xml = response
        .text()
        .await
        .map_err(|error| format!("Failed to read arXiv response: {error}"))?;

    let mut results = parse_arxiv_feed(&xml, query);
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    Ok(results)
}

#[tauri::command]
pub(crate) async fn download_arxiv_pdf(
    app: AppHandle,
    arxiv_id: String,
    on_progress: tauri::ipc::Channel<ArxivDownloadEvent>,
) -> Result<tauri::ipc::Response, String> {
    download_arxiv_pdf_impl(app, arxiv_id, Some(&on_progress)).await
}

#[tauri::command]
pub(crate) async fn download_arxiv_pdf_silent(
    app: AppHandle,
    arxiv_id: String,
) -> Result<tauri::ipc::Response, String> {
    download_arxiv_pdf_impl(app, arxiv_id, None).await
}

async fn download_arxiv_pdf_impl(
    app: AppHandle,
    arxiv_id: String,
    on_progress: Option<&tauri::ipc::Channel<ArxivDownloadEvent>>,
) -> Result<tauri::ipc::Response, String> {
    let arxiv_id = arxiv_id.trim();
    let modern = regex::Regex::new(r"^\d{4}\.\d{4,5}(v\d+)?$").map_err(|error| error.to_string())?;
    let legacy = regex::Regex::new(r"^[A-Za-z-]+(?:\.[A-Za-z-]+)?/\d{7}(v\d+)?$")
        .map_err(|error| error.to_string())?;
    if !modern.is_match(arxiv_id) && !legacy.is_match(arxiv_id) {
        return Err(format!("Invalid arXiv identifier: {arxiv_id}"));
    }

    let url = format!("https://arxiv.org/pdf/{arxiv_id}");
    let mut response = crate::proxy::network_client(&app)?
        .get(&url)
        .header(reqwest::header::USER_AGENT, "lumora/0.1 desktop research library")
        .header(reqwest::header::ACCEPT, "application/pdf")
        .send()
        .await
        .map_err(|error| format!("Failed to download arXiv:{arxiv_id}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("arXiv PDF download failed for {arxiv_id} ({})", response.status()));
    }
    let total_bytes = response.content_length();
    if let Some(channel) = on_progress {
        let _ = channel.send(ArxivDownloadEvent::Started { total_bytes });
    }
    let mut bytes = Vec::with_capacity(total_bytes.unwrap_or(0).min(usize::MAX as u64) as usize);
    while let Some(chunk) = response.chunk().await
        .map_err(|error| format!("Failed to read arXiv PDF {arxiv_id}: {error}"))? {
        bytes.extend_from_slice(&chunk);
        if let Some(channel) = on_progress {
            let _ = channel.send(ArxivDownloadEvent::Progress {
                downloaded_bytes: bytes.len() as u64,
                total_bytes,
            });
        }
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err(format!("arXiv returned non-PDF content for {arxiv_id}"));
    }
    Ok(tauri::ipc::Response::new(bytes))
}

fn parse_arxiv_feed(xml: &str, query_title: &str) -> Vec<ArxivMetadata> {
    let mut results = Vec::new();
    let mut rest = xml;

    while let Some(start) = rest.find("<entry>") {
        let after_start = &rest[start + "<entry>".len()..];
        let Some(end) = after_start.find("</entry>") else {
            break;
        };
        let entry = &after_start[..end];
        rest = &after_start[end + "</entry>".len()..];

        let id_url = clean_text(&read_tag(entry, "id"));
        let arxiv_id = normalize_arxiv_id(&id_url);
        let title = clean_text(&read_tag(entry, "title"));
        if arxiv_id.is_empty() || title.is_empty() {
            continue;
        }

        let abstract_ = clean_text(&read_tag(entry, "summary"));
        let published_at = optional_clean_text(read_tag(entry, "published"));
        let updated_at = optional_clean_text(read_tag(entry, "updated"));
        let doi = optional_clean_text(read_tag(entry, "arxiv:doi"));
        let journal_ref = optional_clean_text(read_tag(entry, "arxiv:journal_ref"));
        let authors = read_authors(entry);
        let categories = read_categories(entry);
        let year = published_at
            .as_ref()
            .and_then(|value| value.get(0..4))
            .and_then(|value| value.parse::<i32>().ok());
        let score = score_title_match(query_title, &title);

        results.push(ArxivMetadata {
            url: format!("https://arxiv.org/abs/{arxiv_id}"),
            arxiv_id,
            title,
            authors,
            year,
            abstract_,
            doi,
            published_at,
            updated_at,
            venue: journal_ref.unwrap_or_else(|| "arXiv".to_string()),
            categories,
            score,
        });
    }

    results
}

fn read_authors(entry: &str) -> Vec<ArxivAuthor> {
    let mut authors = Vec::new();
    let mut rest = entry;

    while let Some(start) = rest.find("<author>") {
        let after_start = &rest[start + "<author>".len()..];
        let Some(end) = after_start.find("</author>") else {
            break;
        };
        let author = &after_start[..end];
        let full_name = clean_text(&read_tag(author, "name"));
        if !full_name.is_empty() {
            authors.push(ArxivAuthor { full_name });
        }
        rest = &after_start[end + "</author>".len()..];
    }

    authors
}

fn read_categories(entry: &str) -> Vec<String> {
    entry
        .split("<category")
        .skip(1)
        .filter_map(|chunk| {
            let term_start = chunk.find("term=\"")? + "term=\"".len();
            let term_rest = &chunk[term_start..];
            let term_end = term_rest.find('"')?;
            Some(term_rest[..term_end].to_string())
        })
        .collect()
}

fn read_tag(xml: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let Some(start) = xml.find(&open) else {
        return String::new();
    };
    let Some(open_end) = xml[start..].find('>') else {
        return String::new();
    };
    let content_start = start + open_end + 1;
    let close = format!("</{tag}>");
    let Some(content_end) = xml[content_start..].find(&close) else {
        return String::new();
    };
    xml[content_start..content_start + content_end].to_string()
}

fn optional_clean_text(value: String) -> Option<String> {
    let cleaned = clean_text(&value);
    (!cleaned.is_empty()).then_some(cleaned)
}

fn clean_text(value: &str) -> String {
    decode_xml_entities(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_xml_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

// Keeps the version suffix (2301.12345v2): the versioned id links to the exact
// revision the metadata describes, and the PDF-extraction path keeps it too.
fn normalize_arxiv_id(value: &str) -> String {
    value
        .split("arxiv.org/abs/")
        .nth(1)
        .unwrap_or(value)
        .split(['?', '#', ' '])
        .next()
        .unwrap_or(value)
        .trim_start_matches("arXiv:")
        .to_string()
}

fn score_title_match(query_title: &str, candidate_title: &str) -> f64 {
    let query_tokens = tokenize(query_title);
    let candidate_tokens = tokenize(candidate_title);
    if query_tokens.is_empty() || candidate_tokens.is_empty() {
        return 0.0;
    }

    let hits = query_tokens
        .iter()
        .filter(|token| candidate_tokens.contains(token))
        .count();
    let coverage = hits as f64 / query_tokens.len() as f64;
    let length_penalty = query_tokens.len().abs_diff(candidate_tokens.len()) as f64
        / query_tokens.len().max(candidate_tokens.len()) as f64;
    (coverage - length_penalty * 0.15).max(0.0)
}

fn tokenize(value: &str) -> Vec<String> {
    value
        .to_lowercase()
        .split(|char: char| !char.is_alphanumeric())
        .filter(|token| token.len() > 2)
        .map(ToString::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::normalize_arxiv_id;

    #[test]
    fn keeps_version_suffix_on_modern_ids() {
        assert_eq!(normalize_arxiv_id("http://arxiv.org/abs/2301.12345v2"), "2301.12345v2");
        assert_eq!(normalize_arxiv_id("arXiv:2301.12345v1"), "2301.12345v1");
    }

    #[test]
    fn keeps_version_suffix_on_legacy_ids() {
        assert_eq!(normalize_arxiv_id("http://arxiv.org/abs/cs/0112017v3"), "cs/0112017v3");
    }

    #[test]
    fn handles_unversioned_ids_and_url_noise() {
        assert_eq!(normalize_arxiv_id("http://arxiv.org/abs/2301.12345"), "2301.12345");
        assert_eq!(normalize_arxiv_id("https://arxiv.org/abs/2301.12345v2?context=cs"), "2301.12345v2");
    }
}
