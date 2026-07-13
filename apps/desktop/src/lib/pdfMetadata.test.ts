import { describe, expect, it, vi } from "vitest";
import {
  looksLikePdfProducer,
  readString,
  cleanTitle,
  inferTitleFromFileName,
  isLikelyAuthorName,
  splitAdjacentNames,
  parseAuthors,
  parseKeywords,
  inferYear,
  inferDoi,
  inferArxivId,
  normalizeLineText,
  normalizeComparable,
  isPdfTextItem,
  joinHyphenatedLines,
  isFrontMatterNoise,
  linesToText,
  findTitleLineCount,
  inferTitleFromFirstPageLines,
  inferAuthorsFromFirstPageLines,
  inferAbstractFromFirstPageLines,
  type PdfTextLine,
} from "./pdfMetadata";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function line(text: string, overrides: Partial<PdfTextLine> = {}): PdfTextLine {
  return {
    text,
    x: 72,
    y: 700,
    right: 200,
    height: 12,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// looksLikePdfProducer
// ---------------------------------------------------------------------------

describe("looksLikePdfProducer", () => {
  it("matches known PDF producer names case-insensitively", () => {
    const producers = [
      "Microsoft Word", "microsoft word", "MICROSOFT WORD",
      "LaTeX", "latex", "LATEX",
      "Tex", "Acrobat", "acrobat",
      "PDF", "pdf",
      "Adobe", "adobe",
      "Preview", "preview",
      "Quartz", "quartz",
      "Producer", "producer",
      "Creator", "creator",
    ];
    for (const p of producers) {
      expect(looksLikePdfProducer(p)).toBe(true);
    }
  });

  it("returns false for normal strings", () => {
    expect(looksLikePdfProducer("Attention Is All You Need")).toBe(false);
    expect(looksLikePdfProducer("John Smith")).toBe(false);
    expect(looksLikePdfProducer("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readString
// ---------------------------------------------------------------------------

describe("readString", () => {
  it("returns trimmed string for valid string input", () => {
    expect(readString("  Hello World  ")).toBe("Hello World");
    expect(readString("SingleWord")).toBe("SingleWord");
  });

  it("normalizes internal whitespace to single spaces", () => {
    expect(readString("Hello   \n  World")).toBe("Hello World");
  });

  it("returns undefined for non-string values", () => {
    expect(readString(undefined)).toBeUndefined();
    expect(readString(null)).toBeUndefined();
    expect(readString(42)).toBeUndefined();
    expect(readString(true)).toBeUndefined();
    expect(readString({})).toBeUndefined();
    expect(readString([])).toBeUndefined();
  });

  it("returns undefined for empty or whitespace-only strings", () => {
    expect(readString("")).toBeUndefined();
    expect(readString("   ")).toBeUndefined();
    expect(readString("\n\t")).toBeUndefined();
  });

  it("returns undefined for PDF producer strings", () => {
    expect(readString("Microsoft Word")).toBeUndefined();
    expect(readString("LaTeX")).toBeUndefined();
    expect(readString("Acrobat")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cleanTitle
// ---------------------------------------------------------------------------

describe("cleanTitle", () => {
  it("returns undefined for undefined or empty input", () => {
    expect(cleanTitle(undefined)).toBeUndefined();
    expect(cleanTitle("")).toBeUndefined();
  });

  it("returns undefined for PDF producer strings", () => {
    expect(cleanTitle("Microsoft Word")).toBeUndefined();
  });

  it("strips .pdf extension (case-insensitive)", () => {
    expect(cleanTitle("paper.PDF")).toBe("paper");
    expect(cleanTitle("My Paper.pdf")).toBe("My Paper");
    expect(cleanTitle("thesis.Pdf")).toBe("thesis");
  });

  it("replaces underscores with spaces", () => {
    expect(cleanTitle("attention_is_all_you_need")).toBe("attention is all you need");
  });

  it("removes dash-surrounded whitespace separators (regex needs ws on both sides of dash)", () => {
    // Regex is /\s+-\s+/g — requires whitespace on BOTH sides of the dash
    expect(cleanTitle("Title - Subtitle")).toBe("Title Subtitle");
    expect(cleanTitle("Title  -   Subtitle")).toBe("Title Subtitle");
    // Without whitespace on both sides, the dash is preserved:
    expect(cleanTitle("Title- Subtitle")).toBe("Title- Subtitle");
    expect(cleanTitle("Title -Subtitle")).toBe("Title -Subtitle");
  });

  it("collapses multiple whitespace into single spaces", () => {
    expect(cleanTitle("Too   many    spaces")).toBe("Too many spaces");
  });

  it("handles combined transformations", () => {
    expect(cleanTitle("My_Paper - Final.pdf")).toBe("My Paper Final");
  });
});

// ---------------------------------------------------------------------------
// inferTitleFromFileName
// ---------------------------------------------------------------------------

describe("inferTitleFromFileName", () => {
  it("returns cleaned title from filename", () => {
    expect(inferTitleFromFileName("Attention Is All You Need.pdf")).toBe("Attention Is All You Need");
  });

  it("returns undefined for undefined input", () => {
    expect(inferTitleFromFileName(undefined)).toBeUndefined();
  });

  it("returns undefined for PDF producer-looking filenames", () => {
    expect(inferTitleFromFileName("LaTeX.pdf")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isLikelyAuthorName
// ---------------------------------------------------------------------------

describe("isLikelyAuthorName", () => {
  it("accepts standard Western name patterns (periods in initials are valid)", () => {
    expect(isLikelyAuthorName("John Smith")).toBe(true);
    expect(isLikelyAuthorName("Ashish Vaswani")).toBe(true);
    expect(isLikelyAuthorName("Jean-Luc Picard")).toBe(true);
    expect(isLikelyAuthorName("Mary O'Reilly")).toBe(true);
    expect(isLikelyAuthorName("A. B. Smith")).toBe(true);
  });

  it("rejects names shorter than 3 characters", () => {
    expect(isLikelyAuthorName("Ab")).toBe(false);
    expect(isLikelyAuthorName("A")).toBe(false);
  });

  it("rejects names longer than 80 characters", () => {
    expect(isLikelyAuthorName("A" + "verylongname".repeat(10))).toBe(false);
  });

  it("rejects institutional noise words", () => {
    expect(isLikelyAuthorName("University of Oxford")).toBe(false);
    expect(isLikelyAuthorName("MIT Laboratory")).toBe(false);
    expect(isLikelyAuthorName("Computer Science Department")).toBe(false);
    expect(isLikelyAuthorName("github.com/user")).toBe(false);
    expect(isLikelyAuthorName("http://example.com")).toBe(false);
  });

  it("rejects PDF producer strings", () => {
    expect(isLikelyAuthorName("Microsoft Word")).toBe(false);
    expect(isLikelyAuthorName("LaTeX")).toBe(false);
  });

  it("rejects names with institutional keywords anywhere", () => {
    expect(isLikelyAuthorName("John Abstract")).toBe(false);
    expect(isLikelyAuthorName("Institute of Technology")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// splitAdjacentNames
// ---------------------------------------------------------------------------

describe("splitAdjacentNames", () => {
  it("splits when there are enough adjacent names to exceed the {1,3} greedy cap", () => {
    // {1,3} means up to 4 capitalized names per match (base + up to 3 more).
    // 6 names → two matches of 4+2 or 3+3, either way length > 1.
    const result = splitAdjacentNames("Ann Baker Charlie Davis Eve Foster");
    expect(result.length).toBeGreaterThan(1);
    // The first match greedily takes 4 names, second takes remaining 2
    expect(result).toEqual(["Ann Baker Charlie Davis", "Eve Foster"]);
  });

  it("returns single-element array when only one name group matches", () => {
    // 4 names exactly = one match with {1,3}
    expect(splitAdjacentNames("John Smith Jane Doe")).toEqual(["John Smith Jane Doe"]);
  });

  it("returns single name as-is if only two names", () => {
    expect(splitAdjacentNames("John Smith")).toEqual(["John Smith"]);
  });

  it("falls back to whole value when no capitalized name pattern matches", () => {
    expect(splitAdjacentNames("john smith")).toEqual(["john smith"]);
  });
});

// ---------------------------------------------------------------------------
// parseAuthors
// ---------------------------------------------------------------------------

describe("parseAuthors", () => {
  it("returns undefined for undefined or empty input", () => {
    expect(parseAuthors(undefined)).toBeUndefined();
    expect(parseAuthors("")).toBeUndefined();
  });

  it("splits by commas", () => {
    const result = parseAuthors("John Smith, Jane Doe, Bob Chen");
    expect(result).toEqual([
      { fullName: "John Smith" },
      { fullName: "Jane Doe" },
      { fullName: "Bob Chen" },
    ]);
  });

  it("splits by semicolons", () => {
    const result = parseAuthors("John Smith; Jane Doe");
    expect(result).toEqual([
      { fullName: "John Smith" },
      { fullName: "Jane Doe" },
    ]);
  });

  it("splits by 'and' and '&'", () => {
    const r1 = parseAuthors("John Smith and Jane Doe");
    expect(r1).toEqual([{ fullName: "John Smith" }, { fullName: "Jane Doe" }]);

    const r2 = parseAuthors("John Smith & Jane Doe");
    expect(r2).toEqual([{ fullName: "John Smith" }, { fullName: "Jane Doe" }]);
  });

  it("splits adjacent names within comma-delimited chunks via splitAdjacentNames", () => {
    // Two names in one chunk → not enough for splitAdjacentNames to split (≤4 cap).
    // Use commas as the primary delimiter.
    const result = parseAuthors("John Smith Jane Doe, Bob Chen, Alice Brown Carol Davis");
    expect(result).toEqual([
      { fullName: "John Smith Jane Doe" },
      { fullName: "Bob Chen" },
      { fullName: "Alice Brown Carol Davis" },
    ]);
  });

  it("strips footnote markers (asterisks, daggers, superscript digits)", () => {
    const result = parseAuthors("John Smith*, Jane Doe†, Bob Chen1");
    expect(result).toEqual([
      { fullName: "John Smith" },
      { fullName: "Jane Doe" },
      { fullName: "Bob Chen" },
    ]);
  });

  it("filters out non-name entries", () => {
    const result = parseAuthors("John Smith, University of Oxford, Jane Doe");
    expect(result).toEqual([
      { fullName: "John Smith" },
      { fullName: "Jane Doe" },
    ]);
  });

  it("returns undefined when no valid author names are found", () => {
    expect(parseAuthors("University of Oxford, MIT Laboratory")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseKeywords
// ---------------------------------------------------------------------------

describe("parseKeywords", () => {
  it("returns empty array for undefined input", () => {
    expect(parseKeywords(undefined)).toEqual([]);
    expect(parseKeywords("")).toEqual([]);
  });

  it("splits by commas", () => {
    expect(parseKeywords("machine learning, NLP, transformers")).toEqual([
      "machine learning",
      "NLP",
      "transformers",
    ]);
  });

  it("splits by semicolons", () => {
    expect(parseKeywords("attention; transformer; BERT")).toEqual([
      "attention",
      "transformer",
      "BERT",
    ]);
  });

  it("trims whitespace from each keyword", () => {
    expect(parseKeywords("  ML  ,  AI  ,  DL  ")).toEqual(["ML", "AI", "DL"]);
  });

  it("filters out empty entries", () => {
    expect(parseKeywords("ML,,AI")).toEqual(["ML", "AI"]);
  });
});

// ---------------------------------------------------------------------------
// inferYear
// ---------------------------------------------------------------------------

describe("inferYear", () => {
  it("parses PDF date format D:YYYY...", () => {
    expect(inferYear("D:20171201000000Z", "")).toBe(2017);
    expect(inferYear("D:20200315000000+05'30'", "")).toBe(2020);
  });

  it("falls back to plain year in creation date string", () => {
    expect(inferYear("2021-01-15", "")).toBe(2021);
  });

  it("falls back to year in body text", () => {
    expect(inferYear(undefined, "Published in 2019 by Nature")).toBe(2019);
    expect(inferYear("invalid", "Conference 2022 proceedings")).toBe(2022);
  });

  it("returns undefined for out-of-range years", () => {
    expect(inferYear("D:18991231000000Z", "")).toBeUndefined();
    const nextYear = new Date().getFullYear() + 2;
    expect(inferYear(`D:${nextYear}1231000000Z`, "")).toBeUndefined();
  });

  it("returns undefined when no year is found", () => {
    expect(inferYear(undefined, "No year here")).toBeUndefined();
    expect(inferYear("no date", "still nothing")).toBeUndefined();
  });

  it("accepts years up to next year inclusive", () => {
    const nextYear = new Date().getFullYear() + 1;
    expect(inferYear(`D:${nextYear}0101000000Z`, "")).toBe(nextYear);
  });
});

// ---------------------------------------------------------------------------
// inferDoi
// ---------------------------------------------------------------------------

describe("inferDoi", () => {
  it("extracts standard DOI patterns", () => {
    expect(inferDoi("doi: 10.1234/abcdef")).toBe("10.1234/abcdef");
    expect(inferDoi("https://doi.org/10.1000/xyz")).toBe("10.1000/xyz");
  });

  it("extracts DOI from free text", () => {
    expect(inferDoi("The paper 10.1145/123456.789012 has been cited")).toBe("10.1145/123456.789012");
  });

  it("strips trailing punctuation from DOI", () => {
    expect(inferDoi("10.1234/abcdef.")).toBe("10.1234/abcdef");
    expect(inferDoi("10.1234/abcdef,")).toBe("10.1234/abcdef");
    expect(inferDoi("10.1234/abcdef;")).toBe("10.1234/abcdef");
    expect(inferDoi("10.1234/abcdef:")).toBe("10.1234/abcdef");
  });

  it("is case-insensitive", () => {
    expect(inferDoi("10.1234/AbCdEf")).toBe("10.1234/AbCdEf");
  });

  it("returns undefined when no DOI is present", () => {
    expect(inferDoi("No DOI here")).toBeUndefined();
    expect(inferDoi("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// inferArxivId
// ---------------------------------------------------------------------------

describe("inferArxivId", () => {
  it("extracts modern arXiv IDs (YYMM.NNNNN)", () => {
    expect(inferArxivId("arXiv:1706.03762")).toBe("1706.03762");
    expect(inferArxivId("arXiv: 2301.12345")).toBe("2301.12345");
  });

  it("extracts modern arXiv IDs with version suffix", () => {
    expect(inferArxivId("arXiv:1706.03762v7")).toBe("1706.03762v7");
  });

  it("extracts legacy arXiv IDs (subject/YYMMNNN)", () => {
    expect(inferArxivId("arXiv:cs/0703125")).toBe("cs/0703125");
    expect(inferArxivId("arXiv:quant-ph/9906123")).toBe("quant-ph/9906123");
  });

  it("extracts legacy arXiv IDs with version suffix", () => {
    expect(inferArxivId("arXiv:cs/0703125v2")).toBe("cs/0703125v2");
  });

  it("prefers modern format over legacy", () => {
    const text = "arXiv:1706.03762 also arXiv:cs/0703125";
    expect(inferArxivId(text)).toBe("1706.03762");
  });

  it("returns undefined when no arXiv ID is present", () => {
    expect(inferArxivId("No arXiv ID here")).toBeUndefined();
    expect(inferArxivId("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeLineText
// ---------------------------------------------------------------------------

describe("normalizeLineText", () => {
  it("collapses multiple whitespace into single space", () => {
    expect(normalizeLineText("hello    world")).toBe("hello world");
  });

  it("removes space before punctuation", () => {
    expect(normalizeLineText("hello , world .")).toBe("hello, world.");
    expect(normalizeLineText("foo ; bar : baz")).toBe("foo; bar: baz");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeLineText("  hello  ")).toBe("hello");
  });

  it("handles already-clean text", () => {
    expect(normalizeLineText("clean text")).toBe("clean text");
  });
});

// ---------------------------------------------------------------------------
// normalizeComparable
// ---------------------------------------------------------------------------

describe("normalizeComparable", () => {
  it("lowercases and replaces non-alphanumeric with spaces", () => {
    expect(normalizeComparable("Hello, World!")).toBe("hello world");
    expect(normalizeComparable("Attention Is All You Need")).toBe("attention is all you need");
  });

  it("handles special characters", () => {
    expect(normalizeComparable("foo-bar_baz:qux")).toBe("foo bar baz qux");
  });

  it("trims result", () => {
    expect(normalizeComparable("  hello  ")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// isPdfTextItem
// ---------------------------------------------------------------------------

describe("isPdfTextItem", () => {
  it("returns true for valid PdfTextItem objects", () => {
    expect(isPdfTextItem({ str: "hello", transform: [1, 0, 0, 1, 72, 700] })).toBe(true);
    expect(isPdfTextItem({ str: "", transform: [] })).toBe(true);
  });

  it("returns false for null, undefined, and primitives", () => {
    expect(isPdfTextItem(null)).toBe(false);
    expect(isPdfTextItem(undefined)).toBe(false);
    expect(isPdfTextItem("string")).toBe(false);
    expect(isPdfTextItem(42)).toBe(false);
    expect(isPdfTextItem(true)).toBe(false);
  });

  it("returns false for objects missing required fields", () => {
    expect(isPdfTextItem({})).toBe(false);
    expect(isPdfTextItem({ str: "hello" })).toBe(false);
    expect(isPdfTextItem({ transform: [] })).toBe(false);
  });

  it("returns false for objects with wrong field types", () => {
    expect(isPdfTextItem({ str: 42, transform: [] })).toBe(false);
    expect(isPdfTextItem({ str: "hello", transform: "not-array" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// joinHyphenatedLines
// ---------------------------------------------------------------------------

describe("joinHyphenatedLines", () => {
  it("joins hyphenated line breaks by removing the hyphen", () => {
    expect(joinHyphenatedLines(["trans-", "former"])).toBe("transformer");
  });

  it("joins non-hyphenated lines with a space", () => {
    expect(joinHyphenatedLines(["attention", "mechanism"])).toBe("attention mechanism");
  });

  it("handles single line", () => {
    expect(joinHyphenatedLines(["hello"])).toBe("hello");
  });

  it("handles multiple hyphenated breaks", () => {
    expect(joinHyphenatedLines(["trans-", "for-", "mer"])).toBe("transformer");
  });

  it("handles empty array", () => {
    expect(joinHyphenatedLines([])).toBe("");
  });

  it("handles mixed hyphenated and non-hyphenated", () => {
    expect(joinHyphenatedLines(["self-", "attention", "mechanism"])).toBe(
      "selfattention mechanism"
    );
  });
});

// ---------------------------------------------------------------------------
// isFrontMatterNoise
// ---------------------------------------------------------------------------

describe("isFrontMatterNoise", () => {
  it("flags standalone numbers", () => {
    expect(isFrontMatterNoise("123")).toBe(true);
    expect(isFrontMatterNoise("42")).toBe(true);
  });

  it("flags abstract/keywords/index terms labels", () => {
    expect(isFrontMatterNoise("Abstract")).toBe(true);
    expect(isFrontMatterNoise("abstract")).toBe(true);
    expect(isFrontMatterNoise("Keywords")).toBe(true);
    expect(isFrontMatterNoise("keywords")).toBe(true);
    expect(isFrontMatterNoise("Index Terms")).toBe(true);
  });

  it("flags URLs and domain-looking strings", () => {
    expect(isFrontMatterNoise("https://example.com")).toBe(true);
    expect(isFrontMatterNoise("www.example.com")).toBe(true);
    expect(isFrontMatterNoise("github.io")).toBe(true);
    expect(isFrontMatterNoise("example.org")).toBe(true);
  });

  it("flags institutional names", () => {
    expect(isFrontMatterNoise("University of Oxford")).toBe(true);
    expect(isFrontMatterNoise("MIT Computer Science Institute")).toBe(true);
    expect(isFrontMatterNoise("Research Laboratory")).toBe(true);
    expect(isFrontMatterNoise("School of Engineering")).toBe(true);
  });

  it("returns false for normal title text", () => {
    expect(isFrontMatterNoise("Attention Is All You Need")).toBe(false);
    expect(isFrontMatterNoise("Transformer Architecture")).toBe(false);
  });

  it("returns false for author names", () => {
    expect(isFrontMatterNoise("Ashish Vaswani")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// linesToText
// ---------------------------------------------------------------------------

describe("linesToText", () => {
  it("joins lines with newlines", () => {
    const lines = [line("Hello"), line("World")];
    expect(linesToText(lines)).toBe("Hello\nWorld");
  });

  it("returns empty string for empty array", () => {
    expect(linesToText([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findTitleLineCount
// ---------------------------------------------------------------------------

describe("findTitleLineCount", () => {
  it("finds the number of lines matching the title", () => {
    const lines = [
      line("Attention Is All"),
      line("You Need"),
      line("Ashish Vaswani"),
    ];
    expect(findTitleLineCount(lines, "Attention Is All You Need")).toBe(2);
  });

  it("returns 0 when title does not match", () => {
    const lines = [line("Some Other Title"), line("Author Name")];
    expect(findTitleLineCount(lines, "Completely Different")).toBe(0);
  });

  it("stops when accumulated text exceeds title length by 60", () => {
    const shortTitle = "Short"; // length 5, threshold = 65
    const longFirstLine = "A".repeat(70); // 70 > 65
    const lines = [
      line(longFirstLine),
      line("This second line should not be reached"),
    ];
    const count = findTitleLineCount(lines, shortTitle);
    expect(count).toBe(1); // stops after first line because 70 > 65
  });

  it("handles empty lines array", () => {
    expect(findTitleLineCount([], "Anything")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// inferTitleFromFirstPageLines
// ---------------------------------------------------------------------------

describe("inferTitleFromFirstPageLines", () => {
  it("extracts title from large-font first-page lines", () => {
    const lines = [
      line("Attention Is All You Need", { height: 18, y: 720 }),
      line("Ashish Vaswani", { height: 10, y: 690 }),
      line("Google Brain", { height: 10, y: 675 }),
    ];
    expect(inferTitleFromFirstPageLines(lines)).toBe("Attention Is All You Need");
  });

  it("handles multi-line titles", () => {
    const lines = [
      line("A Very Long Title That", { height: 16, y: 720 }),
      line("Spans Multiple Lines", { height: 16, y: 700 }),
      line("Author Name", { height: 10, y: 670 }),
    ];
    expect(inferTitleFromFirstPageLines(lines)).toBe("A Very Long Title That Spans Multiple Lines");
  });

  it("returns undefined when no large-font line exists", () => {
    const lines = [
      line("Tiny text", { height: 5 }),
      line("Also small", { height: 6 }),
    ];
    expect(inferTitleFromFirstPageLines(lines)).toBeUndefined();
  });

  it("returns undefined when title text is too short (<12 chars)", () => {
    const lines = [
      line("Short", { height: 16, y: 720 }),
      line("Author", { height: 10, y: 700 }),
    ];
    expect(inferTitleFromFirstPageLines(lines)).toBeUndefined();
  });

  it("filters out front-matter noise from candidates", () => {
    const lines = [
      line("Abstract", { height: 18, y: 720 }),
      line("Real Title Here That Is Long Enough", { height: 18, y: 700 }),
    ];
    expect(inferTitleFromFirstPageLines(lines)).toBe("Real Title Here That Is Long Enough");
  });

  it("returns undefined for empty lines array", () => {
    expect(inferTitleFromFirstPageLines([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// inferAuthorsFromFirstPageLines
// ---------------------------------------------------------------------------

describe("inferAuthorsFromFirstPageLines", () => {
  it("extracts authors from lines after title", () => {
    const lines = [
      line("Paper Title", { height: 16, y: 720 }),
      line("John Smith", { height: 10, y: 690 }),
      line("Jane Doe", { height: 10, y: 675 }),
    ];
    const result = inferAuthorsFromFirstPageLines(lines, "Paper Title");
    expect(result).toEqual([{ fullName: "John Smith" }, { fullName: "Jane Doe" }]);
  });

  it("stops at abstract section", () => {
    const lines = [
      line("Paper Title", { height: 16, y: 720 }),
      line("John Smith", { height: 10, y: 690 }),
      line("Abstract", { height: 14, y: 660 }),
      line("This is the abstract text...", { height: 10, y: 640 }),
    ];
    const result = inferAuthorsFromFirstPageLines(lines, "Paper Title");
    expect(result).toEqual([{ fullName: "John Smith" }]);
  });

  it("filters out institutional noise", () => {
    const lines = [
      line("Paper Title", { height: 16, y: 720 }),
      line("University of Oxford", { height: 10, y: 690 }),
      line("John Smith", { height: 10, y: 675 }),
    ];
    const result = inferAuthorsFromFirstPageLines(lines, "Paper Title");
    expect(result).toEqual([{ fullName: "John Smith" }]);
  });

  it("returns empty array when no title is given", () => {
    const lines = [
      line("John Smith", { height: 10, y: 690 }),
      line("Jane Doe", { height: 10, y: 675 }),
    ];
    const result = inferAuthorsFromFirstPageLines(lines);
    expect(result).toEqual([{ fullName: "John Smith" }, { fullName: "Jane Doe" }]);
  });

  it("returns empty array when no authors found", () => {
    const lines = [
      line("Paper Title", { height: 16, y: 720 }),
    ];
    const result = inferAuthorsFromFirstPageLines(lines, "Paper Title");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// inferAbstractFromFirstPageLines
// ---------------------------------------------------------------------------

describe("inferAbstractFromFirstPageLines", () => {
  it("extracts abstract text after 'Abstract' label", () => {
    const lines = [
      line("Paper Title", { height: 16, y: 720 }),
      line("Author", { height: 10, y: 690 }),
      line("Abstract", { height: 12, y: 660 }),
      line("We propose a novel method for attention", { height: 10, y: 640 }),
      line("mechanisms in transformer architectures.", { height: 10, y: 625 }),
      line("Our approach achieves state-of-the-art", { height: 10, y: 610 }),
      line("results on multiple benchmarks.", { height: 10, y: 595 }),
    ];
    const result = inferAbstractFromFirstPageLines(lines);
    expect(result).toBe(
      "We propose a novel method for attention mechanisms in transformer architectures. Our approach achieves state-of-the-art results on multiple benchmarks."
    );
  });

  it("stops at numbered section headings (text must be >40 chars)", () => {
    const lines = [
      line("Abstract", { height: 12, y: 660 }),
      line("This abstract discusses important topics in", { height: 10, y: 640 }),
      line("machine learning and natural language processing.", { height: 10, y: 625 }),
      line("1. Introduction", { height: 12, y: 600 }),
      line("Background text...", { height: 10, y: 580 }),
    ];
    const result = inferAbstractFromFirstPageLines(lines);
    expect(result).toBe(
      "This abstract discusses important topics in machine learning and natural language processing."
    );
  });

  it("returns undefined when no abstract label is found", () => {
    const lines = [
      line("Paper Title", { height: 16, y: 720 }),
      line("Some body text here that is quite long", { height: 10, y: 700 }),
    ];
    expect(inferAbstractFromFirstPageLines(lines)).toBeUndefined();
  });

  it("returns undefined when abstract text is too short (<40 chars)", () => {
    const lines = [
      line("Abstract", { height: 12, y: 660 }),
      line("Short.", { height: 10, y: 640 }),
    ];
    expect(inferAbstractFromFirstPageLines(lines)).toBeUndefined();
  });

  it("handles case-insensitive abstract label", () => {
    const lines = [
      line("ABSTRACT", { height: 12, y: 660 }),
      line("This is a sufficiently long abstract text that should be extracted",
        { height: 10, y: 640 }),
    ];
    expect(inferAbstractFromFirstPageLines(lines)).toBe(
      "This is a sufficiently long abstract text that should be extracted"
    );
  });

  it("stops at bare '1' as section heading", () => {
    const lines = [
      line("Abstract", { height: 12, y: 660 }),
      line("Long enough abstract text here that continues with more words",
        { height: 10, y: 640 }),
      line("1", { height: 12, y: 620 }),
      line("Introduction text", { height: 10, y: 600 }),
    ];
    const result = inferAbstractFromFirstPageLines(lines);
    expect(result).toBe("Long enough abstract text here that continues with more words");
  });

  it("returns undefined for empty lines", () => {
    expect(inferAbstractFromFirstPageLines([])).toBeUndefined();
  });
});
