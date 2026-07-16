import { memo, useEffect, useState } from "react";
import { renderNativePdfPage } from "../lib/nativePdfRenderer";

type NativePdfPageProps = {
  sessionId: string;
  pageNumber: number;
  cssWidth: number;
  devicePixelRatio: number;
  onLoad?: () => void;
};

export const NativePdfPage = memo(function NativePdfPage({
  sessionId,
  pageNumber,
  cssWidth,
  devicePixelRatio,
  onLoad
}: NativePdfPageProps) {
  const [source, setSource] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setSource(undefined);
    setError(undefined);

    void renderNativePdfPage(sessionId, pageNumber, cssWidth * devicePixelRatio)
      .then((bytes) => {
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/png" }));
        setSource(objectUrl);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [cssWidth, devicePixelRatio, pageNumber, sessionId]);

  if (error) {
    return <div className="native-pdf-page-status">Page render failed: {error}</div>;
  }
  if (!source) {
    return <div className="native-pdf-page-status">Rendering page...</div>;
  }
  return (
    <img
      className="native-pdf-page-image"
      src={source}
      alt=""
      draggable={false}
      onLoad={onLoad}
    />
  );
});
