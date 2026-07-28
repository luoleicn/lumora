import { memo } from "react";
import type {
  NativePdfInternalLinkTarget,
  NativePdfLink
} from "../lib/nativePdfRenderer";

type NativePdfLinkLayerProps = {
  links: NativePdfLink[];
  onInternalLink: (target: NativePdfInternalLinkTarget) => void;
};

export const NativePdfLinkLayer = memo(function NativePdfLinkLayer({
  links,
  onInternalLink
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
        return (
          <a
            key={`${index}-external-${link.target.url}`}
            href={link.target.url}
            aria-label={`Open ${link.target.url}`}
            title={link.target.url}
            style={style}
          />
        );
      })}
    </div>
  );
});
