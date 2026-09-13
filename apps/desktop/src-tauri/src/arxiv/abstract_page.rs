// arXiv's abstract pages expose citation metadata independently of the Atom API.
// Keep this parser separate from the network policy and reject unrelated/error
// pages before they can become library records.
use super::{arxiv_id_base, arxiv_id_matches, validate_arxiv_id, ArxivAuthor, ArxivMetadata};
use regex::Regex;
use std::collections::HashMap;

pub(super) fn parse(html: &str, requested: &str) -> Result<ArxivMetadata, String> {
    let tags = Regex::new(r#"(?is)<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>"#).unwrap();
    let attrs = Regex::new(r#"(?is)([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap();
    let mut metadata: HashMap<String, Vec<String>> = HashMap::new();
    for tag in tags.find_iter(html) {
        let attributes: HashMap<_, _> = attrs.captures_iter(tag.as_str()).map(|attr| {
            (attr[1].to_ascii_lowercase(), decode(attr.get(2).or_else(|| attr.get(3)).unwrap().as_str()))
        }).collect();
        if let (Some(name), Some(content)) = (attributes.get("name").or_else(|| attributes.get("property")), attributes.get("content")) {
            if !content.is_empty() {
                metadata.entry(name.to_ascii_lowercase()).or_default().push(content.clone());
            }
        }
    }
    let first = |key: &str| metadata.get(key).and_then(|values| values.first()).cloned();
    let citation_id = first("citation_arxiv_id")
        .ok_or("No arXiv citation identifier on the abstract page")?;
    validate_arxiv_id(&citation_id)?;
    if arxiv_id_base(&citation_id) != arxiv_id_base(requested) {
        return Err("The abstract page belongs to a different arXiv paper".into());
    }
    // citation_arxiv_id is commonly unversioned; og:url identifies the revision.
    let arxiv_id = first("og:url")
        .and_then(|url| reqwest::Url::parse(&url).ok())
        .filter(|url| url.host_str() == Some("arxiv.org"))
        .and_then(|url| url.path().strip_prefix("/abs/").map(str::to_owned))
        .unwrap_or(citation_id);
    validate_arxiv_id(&arxiv_id)?;
    if !arxiv_id_matches(requested, &arxiv_id) {
        return Err("The abstract page does not match the requested arXiv revision".into());
    }
    let title = first("citation_title").ok_or("No citation title on the abstract page")?;
    let authors = metadata.get("citation_author").into_iter().flatten().map(|name| {
        let full_name = match name.split_once(',') {
            Some((family, given)) if !given.trim().is_empty() => format!("{} {}", given.trim(), family.trim()),
            _ => name.clone(),
        };
        ArxivAuthor { full_name }
    }).collect();
    let published_at = first("citation_date").map(|date| date.replace('/', "-"));
    let year = published_at.as_ref().and_then(|date| date.get(..4)).and_then(|year| year.parse().ok());
    let subjects = Regex::new(r#"(?is)<td\b[^>]*class=["'][^"']*\bsubjects\b[^"']*["'][^>]*>(.*?)</td>"#).unwrap();
    let category = Regex::new(r"\(([A-Za-z-]+(?:\.[A-Za-z-]+)?)\)").unwrap();
    let categories = subjects.captures(html).map(|cell| {
        category.captures_iter(&cell[1]).map(|value| value[1].to_string()).collect()
    }).unwrap_or_default();

    Ok(ArxivMetadata {
        url: format!("https://arxiv.org/abs/{arxiv_id}"),
        arxiv_id,
        title,
        authors,
        year,
        abstract_: first("citation_abstract").or_else(|| first("og:description")).unwrap_or_default(),
        doi: first("citation_doi"),
        published_at,
        // citation_online_date is not the revision timestamp.
        updated_at: None,
        venue: first("citation_journal_title").unwrap_or_else(|| "arXiv".into()),
        categories,
        score: 0.0,
    })
}

fn decode(value: &str) -> String {
    // Decode once: &amp;lt; must stay &lt;, not turn into a markup character.
    let entities = Regex::new(r"&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);").unwrap();
    entities.replace_all(value, |caps: &regex::Captures<'_>| {
        let entity = &caps[1];
        let decoded = match entity {
            "amp" => Some('&'), "lt" => Some('<'), "gt" => Some('>'),
            "quot" => Some('"'), "apos" => Some('\''), "nbsp" => Some(' '),
            _ => entity.strip_prefix("#x").or_else(|| entity.strip_prefix("#X"))
                .and_then(|digits| u32::from_str_radix(digits, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|digits| digits.parse().ok()))
                .and_then(char::from_u32),
        };
        decoded.map(|value| value.to_string()).unwrap_or_else(|| caps[0].to_string())
    }).split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const PAGE: &str = include_str!("fixtures/2608.11739.html");

    #[test]
    fn parses_actual_arxiv_citation_metadata() {
        let paper = parse(PAGE, "2608.11739").unwrap();
        assert_eq!(paper.arxiv_id, "2608.11739v1");
        assert_eq!(paper.title, "G0.5: One Autoregressive Stream for Robot Reasoning and Action");
        assert_eq!(paper.authors.len(), 27);
        assert_eq!(paper.authors[0].full_name, "Yicheng Liu");
        assert_eq!(paper.year, Some(2026));
        assert_eq!(paper.published_at.as_deref(), Some("2026-08-12"));
        assert!(paper.abstract_.contains("VLM's capabilities"));
        assert!(paper.abstract_.contains("$\\pi_{0.5}$"));
        assert_eq!(paper.categories, ["cs.RO", "cs.AI"]);
        assert_eq!(paper.url, "https://arxiv.org/abs/2608.11739v1");
        assert!(paper.updated_at.is_none());
        assert!(parse(PAGE, "2608.11739v1").is_ok());
    }

    #[test]
    fn rejects_wrong_papers_revisions_and_error_pages() {
        assert!(parse(PAGE, "1706.03762").is_err());
        assert!(parse(PAGE, "2608.11739v2").is_err());
        assert!(parse("<title>Too Many Requests</title>", "2608.11739").is_err());
        assert!(parse(&PAGE.replace("citation_title", "other_title"), "2608.11739").is_err());
    }

    #[test]
    fn handles_attribute_order_quotes_and_entities() {
        let page = r#"<META content='2608.11739' NAME='citation_arxiv_id'>
            <meta content='A &gt; B &amp; &quot;C&quot; &#x3b1; &#39; &amp;lt;' name='citation_title'>
            <meta name='citation_author' content='Research Collaboration'>"#;
        let paper = parse(page, "2608.11739").unwrap();
        assert_eq!(paper.title, "A > B & \"C\" α ' &lt;");
        assert_eq!(paper.authors[0].full_name, "Research Collaboration");
        assert!(paper.year.is_none());
    }
}
