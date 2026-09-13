// arXiv integration: title search and id lookup over the Atom API,
// version-pinned PDF downloads with progress events, and the feed/text parsing
// helpers.

use tauri::AppHandle;

mod abstract_page;

const METADATA_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const USER_AGENT: &str = "lumora/0.1 desktop research library";

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

// Keep both metadata sources behind the same proxy-aware client on all platforms.
#[tauri::command]
pub(crate) async fn fetch_arxiv_by_id(app: AppHandle, arxiv_id: String) -> Result<Option<ArxivMetadata>, String> {
    let arxiv_id = validate_arxiv_id(&arxiv_id)?;
    let client = crate::proxy::network_client(&app)?;
    fetch_arxiv_metadata(&client, &arxiv_id, "https://export.arxiv.org/api/query", "https://arxiv.org/abs/").await
}

async fn fetch_arxiv_metadata(
    client: &reqwest::Client,
    arxiv_id: &str,
    api_url: &str,
    abstract_base_url: &str,
) -> Result<Option<ArxivMetadata>, String> {
    let mut url = reqwest::Url::parse(api_url).map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("id_list", arxiv_id)
        .append_pair("start", "0")
        .append_pair("max_results", "1");

    let response = client.get(url)
        .header(reqwest::header::ACCEPT, "application/atom+xml")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .timeout(METADATA_TIMEOUT)
        .send().await;

    // Make one page request on transient API failures instead of repeatedly
    // hitting the rate-limited API. A successful empty feed still means no match.
    let api_error = match response {
        Ok(response) if response.status().is_success() => {
            match response.text().await {
                Ok(xml) => return Ok(parse_arxiv_feed(&xml, "")
                    .into_iter()
                    .find(|entry| arxiv_id_matches(arxiv_id, &entry.arxiv_id))),
                Err(error) => format!("Failed to read arXiv response: {error}"),
            }
        }
        Ok(response) => {
            let status = response.status();
            let error = if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                format!("arXiv API is temporarily rate limited (HTTP 429) for {arxiv_id}")
            } else {
                format!("arXiv lookup failed for {arxiv_id} ({status})")
            };
            if status != reqwest::StatusCode::TOO_MANY_REQUESTS && !status.is_server_error() {
                return Err(error);
            }
            error
        }
        Err(error) => format!("arXiv request failed: {error}"),
    };

    let fallback = async {
        let response = client.get(format!("{abstract_base_url}{arxiv_id}"))
            .header(reqwest::header::ACCEPT, "text/html")
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .timeout(METADATA_TIMEOUT)
            .send().await.map_err(|error| error.to_string())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status()));
        }
        let html = response.text().await.map_err(|error| error.to_string())?;
        abstract_page::parse(&html, arxiv_id).map(Some)
    }.await;
    fallback.map_err(|error| format!("{api_error}. The abstract page fallback also failed: {error}. Please try again later."))
}

fn arxiv_id_matches(requested: &str, actual: &str) -> bool {
    // An explicit version must never silently import another revision.
    if requested != arxiv_id_base(requested) {
        requested == actual
    } else {
        arxiv_id_base(requested) == arxiv_id_base(actual)
    }
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
    let arxiv_id = validate_arxiv_id(&arxiv_id)?;

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

// Drops the version suffix so a request for 1706.03762 matches the 1706.03762v7
// entry arXiv answers with.
fn arxiv_id_base(value: &str) -> &str {
    match value.rfind('v') {
        Some(index) if value[index + 1..].chars().all(|char| char.is_ascii_digit())
            && index + 1 < value.len() => &value[..index],
        _ => value
    }
}

// Rejects anything that is not a modern (2301.12345v2) or legacy (cs/0112017v3)
// arXiv identifier, so a typo fails before any network round trip.
fn validate_arxiv_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let modern = regex::Regex::new(r"^\d{4}\.\d{4,5}(v\d+)?$").map_err(|error| error.to_string())?;
    let legacy = regex::Regex::new(r"^[A-Za-z-]+(?:\.[A-Za-z-]+)?/\d{7}(v\d+)?$")
        .map_err(|error| error.to_string())?;
    if !modern.is_match(trimmed) && !legacy.is_match(trimmed) {
        return Err(format!("Invalid arXiv identifier: {trimmed}"));
    }

    Ok(trimmed.to_string())
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
    use super::{arxiv_id_base, normalize_arxiv_id, parse_arxiv_feed, validate_arxiv_id};

    // Exercise real HTTP responses through the production lookup orchestration.
    // The local server also checks that fallback makes only one request and
    // preserves the requested identifier, including its version.
    fn lookup_with_responses(responses: Vec<(&str, &str)>) -> Result<Option<super::ArxivMetadata>, String> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let responses: Vec<_> = responses.into_iter().map(|(status, body)| (status.to_string(), body.to_string())).collect();
        let server = std::thread::spawn(move || {
            for (index, (status, body)) in responses.into_iter().enumerate() {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(std::time::Instant::now() < deadline, "expected request never arrived");
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                while !request.windows(4).any(|chunk| chunk == b"\r\n\r\n") {
                    let mut buffer = [0; 1024];
                    let length = stream.read(&mut buffer).unwrap();
                    assert!(length > 0);
                    request.extend_from_slice(&buffer[..length]);
                }
                let request = String::from_utf8(request).unwrap();
                let expected = if index == 0 { "/api/query?id_list=2608.11739v1&start=0&max_results=1" } else { "/abs/2608.11739v1" };
                assert!(request.starts_with(&format!("GET {expected} HTTP/1.1")), "{request}");
                assert!(request.to_lowercase().contains("user-agent: lumora/"));
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let result = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            super::fetch_arxiv_metadata(&client, "2608.11739v1", &format!("http://{address}/api/query"), &format!("http://{address}/abs/")).await
        });
        server.join().unwrap();
        result
    }

    #[test]
    fn imports_from_abstract_page_when_api_is_rate_limited_or_unavailable() {
        for status in ["429 Too Many Requests", "503 Service Unavailable"] {
            let paper = lookup_with_responses(vec![
                (status, "temporarily unavailable"),
                ("200 OK", include_str!("arxiv/fixtures/2608.11739.html")),
            ]).unwrap().unwrap();
            assert_eq!(paper.arxiv_id, "2608.11739v1");
            assert_eq!(paper.authors.len(), 27);
        }
    }

    #[test]
    fn preserves_api_success_and_missing_entries_without_fallback() {
        let feed = "<feed><entry><id>http://arxiv.org/abs/2608.11739v1</id><title>G0.5</title></entry></feed>";
        assert_eq!(lookup_with_responses(vec![("200 OK", feed)]).unwrap().unwrap().title, "G0.5");
        assert!(lookup_with_responses(vec![("200 OK", "<feed></feed>")]).unwrap().is_none());
        assert!(lookup_with_responses(vec![("400 Bad Request", "invalid request")]).err().unwrap().contains("400"));
    }

    #[test]
    fn fallback_distinguishes_missing_papers_from_service_errors() {
        assert!(lookup_with_responses(vec![("429 Too Many Requests", ""), ("404 Not Found", "")]).unwrap().is_none());
        for response in [("503 Service Unavailable", ""), ("200 OK", "<title>Error</title>")] {
            let error = lookup_with_responses(vec![("429 Too Many Requests", ""), response]).err().unwrap();
            assert!(error.contains("rate limited (HTTP 429)"));
            assert!(error.contains("fallback also failed"));
        }
    }

    #[test]
    #[ignore = "live arXiv check; requires network access"]
    fn live_lookup_2608_11739() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let client = reqwest::Client::new();
            let paper = super::fetch_arxiv_metadata(&client, "2608.11739", "https://export.arxiv.org/api/query", "https://arxiv.org/abs/").await.unwrap().unwrap();
            assert_eq!(arxiv_id_base(&paper.arxiv_id), "2608.11739");
            assert!(paper.title.starts_with("G0.5:"));
            assert_eq!(paper.authors.len(), 27);
            println!("Imported {}: {} ({} authors)", paper.arxiv_id, paper.title, paper.authors.len());
        });
    }

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

    #[test]
    fn accepts_modern_and_legacy_identifiers() {
        assert_eq!(validate_arxiv_id("1706.03762").unwrap(), "1706.03762");
        assert_eq!(validate_arxiv_id(" 2301.12345v2 ").unwrap(), "2301.12345v2");
        assert_eq!(validate_arxiv_id("cs/0112017").unwrap(), "cs/0112017");
        assert_eq!(validate_arxiv_id("cond-mat.stat-mech/0112017v3").unwrap(), "cond-mat.stat-mech/0112017v3");
    }

    #[test]
    fn rejects_malformed_identifiers() {
        for value in ["", "not-an-id", "1706", "1706.0", "https://arxiv.org/abs/1706.03762", "cs/011201"] {
            assert!(validate_arxiv_id(value).is_err(), "expected {value} to be rejected");
        }
    }

    #[test]
    fn parses_an_id_list_entry() {
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <id>http://arxiv.org/abs/1706.03762v7</id>
            <published>2017-06-12T18:44:11Z</published>
            <updated>2023-08-02T00:41:18Z</updated>
            <title>Attention Is All You Need</title>
            <summary>The dominant sequence transduction models are based on
            complex recurrent networks.</summary>
            <author><name>Ashish Vaswani</name></author>
            <author><name>Noam Shazeer</name></author>
            <arxiv:doi>10.48550/arXiv.1706.03762</arxiv:doi>
            <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
            <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
          </entry>
        </feed>"#;

        let results = parse_arxiv_feed(xml, "");
        assert_eq!(results.len(), 1);
        let entry = &results[0];
        assert_eq!(entry.arxiv_id, "1706.03762v7");
        assert_eq!(entry.title, "Attention Is All You Need");
        assert_eq!(entry.url, "https://arxiv.org/abs/1706.03762v7");
        assert_eq!(
            entry.authors.iter().map(|author| author.full_name.as_str()).collect::<Vec<_>>(),
            vec!["Ashish Vaswani", "Noam Shazeer"]
        );
        assert_eq!(entry.year, Some(2017));
        assert_eq!(entry.doi.as_deref(), Some("10.48550/arXiv.1706.03762"));
        assert_eq!(entry.venue, "arXiv");
        assert_eq!(entry.categories, vec!["cs.CL", "cs.LG"]);
        assert!(entry.abstract_.starts_with("The dominant sequence transduction models"));
    }

    #[test]
    fn returns_nothing_for_an_empty_feed() {
        assert!(parse_arxiv_feed("<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>", "").is_empty());
    }

    #[test]
    fn matches_requested_ids_against_the_version_arxiv_answers_with() {
        assert_eq!(arxiv_id_base("1706.03762v7"), "1706.03762");
        assert_eq!(arxiv_id_base("1706.03762"), "1706.03762");
        assert_eq!(arxiv_id_base("cond-mat.stat-mech/0112017v3"), "cond-mat.stat-mech/0112017");
        assert_eq!(arxiv_id_base("cs/0112017"), "cs/0112017");
        // A bare trailing "v" is not a version marker.
        assert_eq!(arxiv_id_base("1706.03762v"), "1706.03762v");
    }

    // arXiv answers a bad lookup with an entry titled "Error"; the id check in
    // fetch_arxiv_by_id must reject it rather than mint a paper from it.
    #[test]
    fn error_entries_do_not_match_a_requested_id() {
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <id>https://arxiv.org/api/errors#incorrect_id_format_for_abc</id>
            <title>Error</title>
            <summary>incorrect id format for abc</summary>
          </entry>
        </feed>"#;

        let results = parse_arxiv_feed(xml, "");
        assert!(!results.iter().any(|entry| arxiv_id_base(&entry.arxiv_id) == arxiv_id_base("1706.03762")));
    }
}
