import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NativePdfLinkLayer } from "./NativePdfLinkLayer";

describe("NativePdfLinkLayer", () => {
  it("renders separate hit regions for internal and external PDF links", () => {
    const markup = renderToStaticMarkup(
      <NativePdfLinkLayer
        links={[
          {
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.04,
            target: { kind: "internal", pageIndex: 7 }
          },
          {
            x: 0.5,
            y: 0.6,
            width: 0.2,
            height: 0.05,
            target: { kind: "external", url: "https://example.com/paper?section=2" }
          }
        ]}
        onInternalLink={vi.fn()}
      />
    );

    expect(markup).toContain('href="#page=8"');
    expect(markup).toContain('data-internal-link="true"');
    expect(markup).toContain('aria-label="Go to page 8"');
    expect(markup).toContain('href="https://example.com/paper?section=2"');
    expect(markup).toContain("left:10.0000%");
    expect(markup.match(/<a /g)).toHaveLength(2);
  });
});
