#[tauri::command]
fn ping() -> &'static str {
    "lumora-ready"
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArxivAuthor {
    full_name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArxivMetadata {
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
async fn search_arxiv_by_title(title: String) -> Result<Vec<ArxivMetadata>, String> {
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

    let response = reqwest::Client::new()
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping, search_arxiv_by_title])
        .run(tauri::generate_context!())
        .expect("error while running lumora");
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

fn normalize_arxiv_id(value: &str) -> String {
    let id = value
        .split("arxiv.org/abs/")
        .nth(1)
        .unwrap_or(value)
        .split(['?', '#', ' '])
        .next()
        .unwrap_or(value)
        .trim_start_matches("arXiv:");

    if let Some(version_index) = id.rfind('v') {
        if id[version_index + 1..].chars().all(|char| char.is_ascii_digit()) {
            return id[..version_index].to_string();
        }
    }

    id.to_string()
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
