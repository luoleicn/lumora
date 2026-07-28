import {
  findPdfPageRange,
  type PdfPageMetrics,
  type PdfPageRange
} from "./pdfVirtualization";

export type PdfScrollPlan = {
  top: number;
  behavior: ScrollBehavior;
  range: PdfPageRange;
};

export type PdfScrollIntent = PdfScrollPlan & {
  revision: number;
  kind: "restore" | "navigation";
};

export function planPdfScroll(
  metrics: PdfPageMetrics,
  requestedTop: number,
  viewportHeight: number,
  overscanPages: number,
  behavior: ScrollBehavior
): PdfScrollPlan {
  const normalizedViewportHeight = Number.isFinite(viewportHeight)
    ? Math.max(1, viewportHeight)
    : 1;
  const maxTop = Math.max(0, metrics.totalHeight - normalizedViewportHeight);
  const top = Number.isFinite(requestedTop)
    ? Math.min(Math.max(requestedTop, 0), maxTop)
    : 0;

  return {
    top,
    behavior,
    range: findPdfPageRange(metrics, top, normalizedViewportHeight, overscanPages)
  };
}

/**
 * Owns scroll intent ordering for the virtual PDF list.
 *
 * Restoring a saved position and following a PDF link used to write to the
 * same scroll container independently. A late image/onRender callback could
 * therefore overwrite a newer link navigation, most visibly resetting Linux
 * WebKitGTK to page one. Every scroll is now revisioned through one owner.
 */
export class PdfScrollCoordinator {
  private revision = 0;
  private restoring = false;

  resetForDocument(): void {
    this.revision += 1;
    this.restoring = true;
  }

  beginRestore(plan: PdfScrollPlan): PdfScrollIntent {
    this.restoring = true;
    return this.begin("restore", plan);
  }

  beginNavigation(plan: PdfScrollPlan): PdfScrollIntent {
    this.restoring = false;
    return this.begin("navigation", plan);
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }

  complete(intent: PdfScrollIntent): boolean {
    if (!this.isCurrent(intent.revision)) {
      return false;
    }
    if (intent.kind === "restore") {
      this.restoring = false;
    }
    return true;
  }

  get isRestoring(): boolean {
    return this.restoring;
  }

  private begin(kind: PdfScrollIntent["kind"], plan: PdfScrollPlan): PdfScrollIntent {
    this.revision += 1;
    return {
      ...plan,
      revision: this.revision,
      kind
    };
  }
}
