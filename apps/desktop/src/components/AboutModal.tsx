import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import lumoraLogoUrl from "../assets/lumora-logo-64.png";
import { buildTime, formatBuildTime } from "../buildInfo";

type AboutModalProps = {
  open: boolean;
  onClose: () => void;
};

export function AboutModal({ open, onClose }: AboutModalProps) {
  const [version, setVersion] = useState<string>();

  useEffect(() => {
    if (!open) {
      return;
    }

    void getVersion().then(setVersion);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <div className="manual-modal about-modal" role="dialog" aria-modal="true" aria-label="About lumora">
        <button type="button" className="icon-button about-modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>

        <div className="about-modal-body">
          <img src={lumoraLogoUrl} alt="" className="about-modal-mark" />
          <h2>lumora</h2>
          <p className="about-modal-slogan">lumora — light up your literature.</p>
          {version && <p className="about-modal-version">Version {version}</p>}
          <p className="about-modal-build-time">Built {formatBuildTime(buildTime)}</p>

          <div className="about-modal-origin">
            <h3>Where the name comes from</h3>
            <p>lumora blends "Lumos" — the spell for light — with "aurora," the light of dawn.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
