import { describe, expect, it } from "vitest";
import type { Author, Paper } from "@lumora/shared";
import {
  parseReferenceFile,
  parseRis,
  parseBibtex,
  parseBibtexFields,
  readBibtexValue,
  skipComma,
  toPaper,
  parseRefAuthors,
  splitAuthors,
  splitList,
  uniqueStrings,
  first,
  parseYear,
  clean,
  normalizeDoi,
  stripBibtexBraces,
  risTypeToDocumentType,
  bibtexTypeToDocumentType,
} from "./referenceImport";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function paperFields(overrides: Partial<Paper> = {}) {
  const now = new Date().toISOString();
  return {
    id: expect.any(String) as string,
    title: "Untitled paper",
    authors: [] as Author[],
    year: undefined as number | undefined,
    venue: undefined as string | undefined,
    doi: undefined as string | undefined,
    abstract: undefined as string | undefined,
    source: "import",
    documentType: "journalArticle",
    tags: [] as string[],
    keywords: [] as string[],
    url: undefined as string | undefined,
    pages: undefined as string | undefined,
    volume: undefined as string | undefined,
    issue: undefined as string | undefined,
    publisher: undefined as string | undefined,
    favorite: false,
    needsReview: false,
    unread: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

describe("clean", () => {
  it("trims whitespace", () => {
    expect(clean("  hello  ")).toBe("hello");
  });

  it("returns undefined for empty or whitespace-only strings", () => {
    expect(clean("")).toBeUndefined();
    expect(clean("   ")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(clean(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseYear
// ---------------------------------------------------------------------------

describe("parseYear", () => {
  it("extracts 4-digit year", () => {
    expect(parseYear("2021")).toBe(2021);
    expect(parseYear("Published 2019")).toBe(2019);
  });

  it("returns undefined when no year found", () => {
    expect(parseYear("abc")).toBeUndefined();
    expect(parseYear("")).toBeUndefined();
    expect(parseYear(undefined)).toBeUndefined();
  });

  it("extracts first 4-digit number", () => {
    expect(parseYear("2020-01-15")).toBe(2020);
  });
});

// ---------------------------------------------------------------------------
// normalizeDoi
// ---------------------------------------------------------------------------

describe("normalizeDoi", () => {
  it("strips https://doi.org/ prefix", () => {
    expect(normalizeDoi("https://doi.org/10.1234/abcd")).toBe("10.1234/abcd");
  });

  it("strips http://dx.doi.org/ prefix", () => {
    expect(normalizeDoi("http://dx.doi.org/10.1234/abcd")).toBe("10.1234/abcd");
  });

  it("strips https://dx.doi.org/ prefix", () => {
    expect(normalizeDoi("https://dx.doi.org/10.1234/abcd")).toBe("10.1234/abcd");
  });

  it("leaves bare DOI unchanged", () => {
    expect(normalizeDoi("10.1234/abcd")).toBe("10.1234/abcd");
  });

  it("returns undefined for undefined input", () => {
    expect(normalizeDoi(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stripBibtexBraces
// ---------------------------------------------------------------------------

describe("stripBibtexBraces", () => {
  it("removes curly braces", () => {
    expect(stripBibtexBraces("{Hello World}")).toBe("Hello World");
    expect(stripBibtexBraces("{\\em Some} text")).toBe("\\em Some text");
  });

  it("leaves brace-free text unchanged", () => {
    expect(stripBibtexBraces("Plain text")).toBe("Plain text");
  });

  it("returns undefined for undefined input", () => {
    expect(stripBibtexBraces(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// skipComma
// ---------------------------------------------------------------------------

describe("skipComma", () => {
  it("skips commas and whitespace", () => {
    // ",  next" — comma + 2 spaces + 'n'. Stops at the 'n' which is index 3.
    expect(skipComma(",  next", 0)).toBe(3);
    expect(skipComma("   next", 0)).toBe(3);
  });

  it("returns cursor unchanged if no comma/space at position", () => {
    expect(skipComma("ab", 0)).toBe(0);
  });

  it("does not advance past end of string", () => {
    expect(skipComma("  ", 0)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// uniqueStrings
// ---------------------------------------------------------------------------

describe("uniqueStrings", () => {
  it("deduplicates and trims", () => {
    expect(uniqueStrings(["a", " a ", "b", "a"])).toEqual(["a", "b"]);
  });

  it("filters empty strings", () => {
    expect(uniqueStrings(["", "a", "  "])).toEqual(["a"]);
  });

  it("returns empty array for empty input", () => {
    expect(uniqueStrings([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// splitList
// ---------------------------------------------------------------------------

describe("splitList", () => {
  it("splits by commas and semicolons", () => {
    expect(splitList("a, b; c")).toEqual(["a", "b", "c"]);
  });

  it("deduplicates", () => {
    expect(splitList("a, a, b")).toEqual(["a", "b"]);
  });

  it("returns empty array for undefined", () => {
    expect(splitList(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// splitAuthors
// ---------------------------------------------------------------------------

describe("splitAuthors", () => {
  it("splits by 'and' (case-insensitive)", () => {
    expect(splitAuthors("John Smith and Jane Doe")).toEqual(["John Smith", "Jane Doe"]);
    expect(splitAuthors("John Smith AND Jane Doe")).toEqual(["John Smith", "Jane Doe"]);
  });

  it("returns single author unchanged", () => {
    expect(splitAuthors("John Smith")).toEqual(["John Smith"]);
  });

  it("returns empty array for undefined", () => {
    expect(splitAuthors(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseRefAuthors
// ---------------------------------------------------------------------------

describe("parseRefAuthors", () => {
  it("parses comma-separated names (LastName, FirstName)", () => {
    const result = parseRefAuthors(["Vaswani, Ashish"]);
    expect(result).toEqual([
      { firstName: "Ashish", lastName: "Vaswani", fullName: "Ashish Vaswani" },
    ]);
  });

  it("handles multi-part last names with comma", () => {
    const result = parseRefAuthors(["van der Waals, Johannes Diderik"]);
    expect(result).toEqual([
      {
        firstName: "Johannes Diderik",
        lastName: "van der Waals",
        fullName: "Johannes Diderik van der Waals",
      },
    ]);
  });

  it("parses space-separated names (FirstName LastName)", () => {
    const result = parseRefAuthors(["Ashish Vaswani"]);
    expect(result).toEqual([
      { firstName: "Ashish", lastName: "Vaswani", fullName: "Ashish Vaswani" },
    ]);
  });

  it("handles middle names in space-separated format", () => {
    const result = parseRefAuthors(["John David Smith"]);
    expect(result[0]).toMatchObject({
      firstName: "John David",
      lastName: "Smith",
      fullName: "John David Smith",
    });
  });

  it("filters empty entries", () => {
    const result = parseRefAuthors(["John Smith", "", "  ", "Jane Doe"]);
    expect(result).toHaveLength(2);
    expect(result[0].fullName).toBe("John Smith");
    expect(result[1].fullName).toBe("Jane Doe");
  });

  it("returns empty array for empty input", () => {
    expect(parseRefAuthors([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// first
// ---------------------------------------------------------------------------

describe("first", () => {
  it("returns first matching key value", () => {
    const map = new Map([["AU", ["John Smith"]], ["TI", ["My Title"]]]);
    expect(first(map, "AU")).toBe("John Smith");
  });

  it("tries fallback keys in order", () => {
    const map = new Map([["T1", ["Fallback Title"]]]);
    expect(first(map, "TI", "T1", "CT")).toBe("Fallback Title");
  });

  it("skips empty string values (but spaces-only is truthy, not trimmed)", () => {
    // find(Boolean) checks truthiness — "" is falsy, "  " is truthy (spaces are non-empty)
    const map = new Map([["TI", ["", ""]], ["T1", ["Real Title"]]]);
    expect(first(map, "TI", "T1")).toBe("Real Title");
  });

  it("returns undefined when no key matches", () => {
    const map = new Map([["XX", ["value"]]]);
    expect(first(map, "TI", "T1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// risTypeToDocumentType
// ---------------------------------------------------------------------------

describe("risTypeToDocumentType", () => {
  it("maps BOOK → book", () => {
    expect(risTypeToDocumentType("BOOK")).toBe("book");
  });

  it("maps CHAP → bookSection", () => {
    expect(risTypeToDocumentType("CHAP")).toBe("bookSection");
  });

  it("maps CONF / CPAPER → conferencePaper", () => {
    expect(risTypeToDocumentType("CONF")).toBe("conferencePaper");
    expect(risTypeToDocumentType("CPAPER")).toBe("conferencePaper");
  });

  it("maps THES → thesis", () => {
    expect(risTypeToDocumentType("THES")).toBe("thesis");
  });

  it("defaults to journalArticle for unknown types", () => {
    expect(risTypeToDocumentType("JOUR")).toBe("journalArticle");
    expect(risTypeToDocumentType(undefined)).toBe("journalArticle");
  });

  it("is case-insensitive", () => {
    expect(risTypeToDocumentType("book")).toBe("book");
    expect(risTypeToDocumentType("Conf")).toBe("conferencePaper");
  });
});

// ---------------------------------------------------------------------------
// bibtexTypeToDocumentType
// ---------------------------------------------------------------------------

describe("bibtexTypeToDocumentType", () => {
  it("maps book → book", () => {
    expect(bibtexTypeToDocumentType("book")).toBe("book");
  });

  it("maps inbook / incollection → bookSection", () => {
    expect(bibtexTypeToDocumentType("inbook")).toBe("bookSection");
    expect(bibtexTypeToDocumentType("incollection")).toBe("bookSection");
  });

  it("maps inproceedings / conference → conferencePaper", () => {
    expect(bibtexTypeToDocumentType("inproceedings")).toBe("conferencePaper");
    expect(bibtexTypeToDocumentType("conference")).toBe("conferencePaper");
  });

  it("maps phdthesis / mastersthesis → thesis", () => {
    expect(bibtexTypeToDocumentType("phdthesis")).toBe("thesis");
    expect(bibtexTypeToDocumentType("mastersthesis")).toBe("thesis");
  });

  it("defaults to journalArticle for unknown types", () => {
    expect(bibtexTypeToDocumentType("article")).toBe("journalArticle");
    expect(bibtexTypeToDocumentType(undefined)).toBe("journalArticle");
  });
});

// ---------------------------------------------------------------------------
// toPaper
// ---------------------------------------------------------------------------

describe("toPaper", () => {
  it("produces a Paper with defaults for minimal input", () => {
    const result = toPaper({ authors: [], title: "Test" });
    expect(result).toMatchObject({
      title: "Test",
      authors: [],
      source: "import",
      documentType: "journalArticle",
      favorite: false,
      needsReview: false,
      unread: true,
    });
    expect(result.id).toMatch(/^paper_/);
    expect(typeof result.createdAt).toBe("string");
    expect(typeof result.updatedAt).toBe("string");
  });

  it("uses 'Untitled paper' when title is missing or empty", () => {
    expect(toPaper({ authors: [] }).title).toBe("Untitled paper");
    expect(toPaper({ authors: [], title: "" }).title).toBe("Untitled paper");
  });

  it("preserves all provided fields", () => {
    const result = toPaper({
      title: "Attention Is All You Need",
      authors: [{ fullName: "Ashish Vaswani" }],
      year: 2017,
      venue: "NeurIPS",
      doi: "10.1234/abcd",
      abstract: "The dominant sequence transduction models...",
      documentType: "conferencePaper",
      tags: ["deep-learning"],
      keywords: ["transformer"],
      url: "https://arxiv.org/abs/1706.03762",
      pages: "1-11",
      volume: "30",
      issue: "1",
      publisher: "Curran Associates",
    });
    expect(result).toMatchObject({
      title: "Attention Is All You Need",
      authors: [{ fullName: "Ashish Vaswani" }],
      year: 2017,
      venue: "NeurIPS",
      doi: "10.1234/abcd",
      abstract: "The dominant sequence transduction models...",
      documentType: "conferencePaper",
      tags: ["deep-learning"],
      keywords: ["transformer"],
      url: "https://arxiv.org/abs/1706.03762",
      pages: "1-11",
      volume: "30",
      issue: "1",
      publisher: "Curran Associates",
    });
  });
});

// ---------------------------------------------------------------------------
// readBibtexValue
// ---------------------------------------------------------------------------

describe("readBibtexValue", () => {
  it("reads brace-delimited values", () => {
    const result = readBibtexValue("title = {Hello World}, year = {2020}", 8);
    expect(result.value).toBe("Hello World");
    expect(result.nextCursor).toBeGreaterThan(8);
  });

  it("reads quote-delimited values", () => {
    const result = readBibtexValue("title = \"Hello World\", year = {2020}", 8);
    expect(result.value).toBe("Hello World");
  });

  it("handles nested braces", () => {
    const result = readBibtexValue("title = {Outer {inner} text},", 8);
    expect(result.value).toBe("Outer {inner} text");
  });

  it("reads unquoted values (plain)", () => {
    const result = readBibtexValue("title = 2020, author = {John}", 8);
    expect(result.value).toBe("2020");
  });

  it("handles unquoted value at end of string", () => {
    const result = readBibtexValue("title = 2020", 8);
    expect(result.value).toBe("2020");
  });

  it("handles escaped quotes in quoted values (backslashes preserved)", () => {
    // The function skips a closing quote preceded by backslash, but leaves
    // the backslash characters in the returned value.
    const result = readBibtexValue('title = "He said \\"hello\\" there",', 8);
    expect(result.value).toBe('He said \\"hello\\" there');
  });
});

// ---------------------------------------------------------------------------
// parseBibtexFields
// ---------------------------------------------------------------------------

describe("parseBibtexFields", () => {
  it("parses a full BibTeX entry's fields", () => {
    const entry = `@article{vaswani2017attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  year = {2017},
  journal = {NeurIPS},
  doi = {10.1234/abcd}
}`;
    const fields = parseBibtexFields(entry);
    expect(fields).toEqual({
      title: "Attention Is All You Need",
      author: "Vaswani, Ashish and Shazeer, Noam",
      year: "2017",
      journal: "NeurIPS",
      doi: "10.1234/abcd",
    });
  });

  it("strips braces from field values", () => {
    const entry = `@article{key, title = {{Large} Language Models}}`;
    const fields = parseBibtexFields(entry);
    expect(fields.title).toBe("Large Language Models");
  });

  it("handles fields with hyphens and underscores in keys", () => {
    const entry = `@article{key, book-title = {Some Book}, issue_date = {2020}}`;
    const fields = parseBibtexFields(entry);
    expect(fields).toHaveProperty("book-title");
    expect(fields).toHaveProperty("issue_date");
  });

  it("returns empty object for entry with no fields", () => {
    const entry = `@article{key,}`;
    const fields = parseBibtexFields(entry);
    expect(fields).toEqual({});
  });

  it("handles quoted field values", () => {
    const entry = '@article{key, title = "Quoted Title"}';
    const fields = parseBibtexFields(entry);
    expect(fields.title).toBe("Quoted Title");
  });

  it("skips empty field values", () => {
    const entry = "@article{key, title = {}, author = {John}}";
    const fields = parseBibtexFields(entry);
    expect(fields).not.toHaveProperty("title");
    expect(fields.author).toBe("John");
  });
});

// ---------------------------------------------------------------------------
// parseRis
// ---------------------------------------------------------------------------

describe("parseRis", () => {
  it("parses a complete RIS record", () => {
    const ris = `TY  - JOUR
TI  - Attention Is All You Need
AU  - Vaswani, Ashish
AU  - Shazeer, Noam
PY  - 2017
JO  - NeurIPS
DO  - 10.1234/abcd
AB  - The dominant sequence transduction models
KW  - deep learning
KW  - transformer
SP  - 1
EP  - 11
VL  - 30
IS  - 1
PB  - Curran Associates
ER  -`;
    const papers = parseRis(ris);
    expect(papers).toHaveLength(1);
    const paper = papers[0];
    expect(paper).toMatchObject({
      title: "Attention Is All You Need",
      year: 2017,
      venue: "NeurIPS",
      doi: "10.1234/abcd",
      abstract: "The dominant sequence transduction models",
      pages: "1-11",
      volume: "30",
      issue: "1",
      publisher: "Curran Associates",
    });
    expect(paper.authors).toEqual([
      { firstName: "Ashish", lastName: "Vaswani", fullName: "Ashish Vaswani" },
      { firstName: "Noam", lastName: "Shazeer", fullName: "Noam Shazeer" },
    ]);
  });

  it("parses multiple RIS records", () => {
    const ris = `TY  - JOUR
TI  - Paper One
AU  - Author One
PY  - 2020
ER  -

TY  - JOUR
TI  - Paper Two
AU  - Author Two
PY  - 2021
ER  -`;
    const papers = parseRis(ris);
    expect(papers).toHaveLength(2);
    expect(papers[0].title).toBe("Paper One");
    expect(papers[1].title).toBe("Paper Two");
  });

  it("uses fallback RIS fields", () => {
    const ris = `TY  - JOUR
T1  - Fallback Title
A1  - Single Author
Y1  - 2019
JF  - Fallback Journal
N2  - Fallback Abstract
UR  - https://example.com
ER  -`;
    const papers = parseRis(ris);
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({
      title: "Fallback Title",
      year: 2019,
      venue: "Fallback Journal",
      abstract: "Fallback Abstract",
      url: "https://example.com",
    });
  });

  it("maps RIS type codes", () => {
    const conf = parseRis("TY  - CONF\nTI  - Conf Paper\nAU  - Author\nPY  - 2020\nER  -");
    expect(conf[0].documentType).toBe("conferencePaper");

    const book = parseRis("TY  - BOOK\nTI  - A Book\nAU  - Author\nPY  - 2020\nER  -");
    expect(book[0].documentType).toBe("book");

    const thesis = parseRis("TY  - THES\nTI  - Thesis\nAU  - Author\nPY  - 2020\nER  -");
    expect(thesis[0].documentType).toBe("thesis");
  });

  it("returns empty array for empty input", () => {
    expect(parseRis("")).toEqual([]);
  });

  it("preserves keyword order and deduplicates", () => {
    const ris = `TY  - JOUR
TI  - Test
AU  - Author
PY  - 2020
KW  - NLP
KW  - transformer
KW  - NLP
ER  -`;
    const papers = parseRis(ris);
    expect(papers[0].keywords).toEqual(["NLP", "transformer"]);
    expect(papers[0].tags).toEqual(["NLP", "transformer"]);
  });
});

// ---------------------------------------------------------------------------
// parseBibtex
// ---------------------------------------------------------------------------

describe("parseBibtex", () => {
  it("parses a complete @article entry", () => {
    const bib = `@article{vaswani2017attention,
  author = {Vaswani, Ashish and Shazeer, Noam},
  title = {Attention Is All You Need},
  journal = {NeurIPS},
  year = {2017},
  doi = {10.1234/abcd},
  abstract = {The dominant sequence transduction models},
  keywords = {deep learning, transformer},
  volume = {30},
  number = {1},
  pages = {1--11},
  publisher = {Curran Associates}
}`;
    const papers = parseBibtex(bib);
    expect(papers).toHaveLength(1);
    const paper = papers[0];
    expect(paper).toMatchObject({
      title: "Attention Is All You Need",
      year: 2017,
      venue: "NeurIPS",
      doi: "10.1234/abcd",
      abstract: "The dominant sequence transduction models",
      pages: "1--11",
      volume: "30",
      issue: "1",
      publisher: "Curran Associates",
    });
    expect(paper.authors).toHaveLength(2);
  });

  it("parses multiple BibTeX entries", () => {
    const bib = `@article{paper1,
  title = {First Paper},
  author = {Author One},
  year = {2020}
}

@inproceedings{paper2,
  title = {Second Paper},
  author = {Author Two},
  booktitle = {Conference},
  year = {2021}
}`;
    const papers = parseBibtex(bib);
    expect(papers).toHaveLength(2);
    expect(papers[0].title).toBe("First Paper");
    expect(papers[1].title).toBe("Second Paper");
    expect(papers[1].documentType).toBe("conferencePaper");
  });

  it("uses booktitle as venue fallback for inproceedings", () => {
    const bib = `@inproceedings{key,
  title = {Conf Paper},
  author = {Author},
  booktitle = {Proc. of Some Conference},
  year = {2020}
}`;
    const papers = parseBibtex(bib);
    expect(papers[0].venue).toBe("Proc. of Some Conference");
  });

  it("uses publisher as venue fallback when journal/booktitle missing", () => {
    const bib = `@book{key,
  title = {A Book},
  author = {Author},
  publisher = {Springer},
  year = {2020}
}`;
    const papers = parseBibtex(bib);
    expect(papers[0].venue).toBe("Springer");
  });

  it("maps BibTeX entry types to documentType", () => {
    const types = [
      ["@book", "book"],
      ["@inbook", "bookSection"],
      ["@incollection", "bookSection"],
      ["@inproceedings", "conferencePaper"],
      ["@conference", "conferencePaper"],
      ["@phdthesis", "thesis"],
      ["@mastersthesis", "thesis"],
      ["@article", "journalArticle"],
    ];
    for (const [type, expected] of types) {
      const bib = `@${type}{key, title = {Test}, author = {A}, year = {2020}}`;
      expect(parseBibtex(bib)[0].documentType).toBe(expected);
    }
  });

  it("returns empty array for empty input", () => {
    expect(parseBibtex("")).toEqual([]);
  });

  it("handles entries with nested braces in titles", () => {
    const bib = `@article{key, title = {BERT: {Pre-training} of {Deep} {Bidirectional} {Transformers}}}`;
    const papers = parseBibtex(bib);
    expect(papers[0].title).toBe("BERT: Pre-training of Deep Bidirectional Transformers");
  });

  it("handles quoted string values", () => {
    const bib = '@article{key, title = "Quoted Title", author = "John Smith"}';
    const papers = parseBibtex(bib);
    expect(papers[0].title).toBe("Quoted Title");
  });

  it("handles entries with url field", () => {
    const bib = `@article{key,
  title = {Test},
  author = {Author},
  year = {2020},
  url = {https://arxiv.org/abs/1234.5678}
}`;
    const papers = parseBibtex(bib);
    expect(papers[0].url).toBe("https://arxiv.org/abs/1234.5678");
  });
});

// ---------------------------------------------------------------------------
// parseReferenceFile (dispatcher)
// ---------------------------------------------------------------------------

describe("parseReferenceFile", () => {
  it("dispatches to RIS parser for .ris files", () => {
    const ris = "TY  - JOUR\nTI  - Test\nAU  - Author\nPY  - 2020\nER  -";
    expect(parseReferenceFile("test.ris", ris)).toHaveLength(1);
    expect(parseReferenceFile("test.RIS", ris)).toHaveLength(1);
  });

  it("dispatches to RIS parser when content starts with TY  -", () => {
    const ris = "TY  - JOUR\nTI  - Test\nAU  - Author\nPY  - 2020\nER  -";
    expect(parseReferenceFile("unknown.txt", ris)).toHaveLength(1);
  });

  it("dispatches to BibTeX parser for .bib files", () => {
    const bib = '@article{key, title = {Test}, author = {A}, year = {2020}}';
    expect(parseReferenceFile("test.bib", bib)).toHaveLength(1);
  });

  it("dispatches to BibTeX parser for unknown extensions not starting with TY", () => {
    const bib = '@article{key, title = {Test}, author = {A}, year = {2020}}';
    expect(parseReferenceFile("export.txt", bib)).toHaveLength(1);
  });
});
