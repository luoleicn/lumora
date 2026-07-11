import { useEffect } from "react";
import { X } from "lucide-react";

type ShortcutsHelpModalProps = {
  open: boolean;
  onClose: () => void;
};

type ShortcutEntry = {
  keys: string[];
  description: string;
};

type ShortcutSection = {
  title: string;
  entries: ShortcutEntry[];
};

const isApplePlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
const mod = isApplePlatform ? "⌘" : "Ctrl";

const sections: ShortcutSection[] = [
  {
    title: "Tabs",
    entries: [
      { keys: [`${mod} 1`], description: "Go to the Documents tab" },
      { keys: [`${mod} 2`, "...", `${mod} 9`], description: "Go to an open paper (in tab order)" },
      { keys: [`${mod} W`], description: "Close the current tab" }
    ]
  },
  {
    title: "PDF Reading",
    entries: [
      { keys: [`${mod} F`], description: "Find in document" },
      { keys: ["Pinch", isApplePlatform ? "⌃ Scroll" : "Ctrl Scroll"], description: "Zoom in / out" },
      { keys: [`${mod} ;`], description: "Fit page to width" },
      { keys: [`${mod} G`], description: "Go to page..." }
    ]
  },
  {
    title: "Panels",
    entries: [
      { keys: [`${mod} J`], description: "Show / hide the library sidebar" },
      { keys: [`${mod} I`], description: "Show / hide the sync panel" }
    ]
  },
  {
    title: "General",
    entries: [
      { keys: ["Esc"], description: "Close dialogs and menus" }
    ]
  }
];

export function ShortcutsHelpModal({ open, onClose }: ShortcutsHelpModalProps) {
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
      <div className="manual-modal shortcuts-modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header>
          <div>
            <h2>Keyboard Shortcuts</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="shortcuts-modal-body">
          {sections.map((section) => (
            <section key={section.title}>
              <h3>{section.title}</h3>
              <ul>
                {section.entries.map((entry) => (
                  <li key={entry.description}>
                    <span className="shortcut-keys">
                      {entry.keys.map((key, index) => (
                        key === "..."
                          ? <span key={index} className="shortcut-ellipsis">...</span>
                          : <kbd key={index}>{key}</kbd>
                      ))}
                    </span>
                    <span className="shortcut-description">{entry.description}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
