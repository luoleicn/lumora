import { memo, useEffect, useMemo, useRef, useState } from "react";
import { loadNativePdfPageText, type NativePdfPageInfo } from "../lib/nativePdfRenderer";

type NativePdfWord = {
  key: string;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

type NativePdfTextLayerProps = {
  sessionId: string;
  pageNumber: number;
  page: NativePdfPageInfo;
  cssHeight: number;
  onReady?: () => void;
};

export const NativePdfTextLayer = memo(function NativePdfTextLayer({
  sessionId,
  pageNumber,
  page,
  cssHeight,
  onReady
}: NativePdfTextLayerProps) {
  const [markup, setMarkup] = useState<string>();
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    let cancelled = false;
    setMarkup(undefined);
    void loadNativePdfPageText(sessionId, pageNumber).then((value) => {
      if (!cancelled) {
        setMarkup(value);
        requestAnimationFrame(() => onReadyRef.current?.());
      }
    }).catch(() => {
      if (!cancelled) {
        setMarkup("");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pageNumber, sessionId]);

  const words = useMemo(
    () => parseNativePdfWords(markup, page),
    [markup, page]
  );

  return (
    <div className="react-pdf__Page__textContent native-pdf-text-layer">
      {words.map((word) => (
        <span
          key={word.key}
          style={{
            left: `${word.left.toFixed(3)}%`,
            top: `${word.top.toFixed(3)}%`,
            width: `${word.width.toFixed(3)}%`,
            height: `${word.height.toFixed(3)}%`,
            fontSize: `${Math.max(1, word.height * cssHeight / 100).toFixed(2)}px`
          }}
        >
          {word.text}{" "}
        </span>
      ))}
    </div>
  );
});

function parseNativePdfWords(markup: string | undefined, page: NativePdfPageInfo): NativePdfWord[] {
  if (!markup || page.width <= 0 || page.height <= 0) {
    return [];
  }
  const document = new DOMParser().parseFromString(markup, "application/xhtml+xml");
  return Array.from(document.querySelectorAll("word")).slice(0, 5000).flatMap((element, index) => {
    const xMin = Number.parseFloat(element.getAttribute("xMin") ?? "");
    const yMin = Number.parseFloat(element.getAttribute("yMin") ?? "");
    const xMax = Number.parseFloat(element.getAttribute("xMax") ?? "");
    const yMax = Number.parseFloat(element.getAttribute("yMax") ?? "");
    if (![xMin, yMin, xMax, yMax].every(Number.isFinite) || xMax <= xMin || yMax <= yMin) {
      return [];
    }
    return [{
      key: `${index}-${xMin.toFixed(2)}-${yMin.toFixed(2)}`,
      text: element.textContent ?? "",
      left: xMin / page.width * 100,
      top: yMin / page.height * 100,
      width: (xMax - xMin) / page.width * 100,
      height: (yMax - yMin) / page.height * 100
    }];
  });
}
