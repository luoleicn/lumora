import { memo } from "react";
import type {
  NativePdfInternalLinkTarget,
  NativePdfLink
} from "../lib/nativePdfRenderer";

type NativePdfLinkLayerProps = {
  links: NativePdfLink[];
  onInternalLink: (target: NativePdfInternalLinkTarget) => void;
  onExternalLink: (url: string) => void;
};

export const NativePdfLinkLayer = memo(function NativePdfLinkLayer({
  links,
  onInternalLink,
  onExternalLink
}: NativePdfLinkLayerProps) {
  return (
    <div className="native-pdf-link-layer" aria-hidden={links.length === 0}>
      {links.map((link, index) => {
        const style = {
          left: `${(link.x * 100).toFixed(4)}%`,
          top: `${(link.y * 100).toFixed(4)}%`,
          width: `${(link.width * 100).toFixed(4)}%`,
          height: `${(link.height * 100).toFixed(4)}%`
        };
        if (link.target.kind === "internal") {
          const target = link.target;
          return (
            <button
              type="button"
              key={`${index}-internal-${target.pageIndex}`}
              data-internal-link
              aria-label={`Go to page ${target.pageIndex + 1}`}
              style={style}
              onClick={() => onInternalLink(target)}
            />
          );
        }
        const url = link.target.url;
        return (
          <a
            key={`${index}-external-${url}`}
            href={url}
            aria-label={`Open ${url}`}
            title={url}
            style={style}
            // WebKit treats every anchor as a native drag source, and these hit
            // regions are empty boxes: pressing one and moving a pixel starts a
            // link drag instead of producing a click, so the link reads as dead.
            draggable={false}
            // Open through the handler rather than relying only on the reader's
            // delegated capture listener, which is shared with the PDF.js path.
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onExternalLink(url);
            }}
          />
        );
      })}
    </div>
  );
});
