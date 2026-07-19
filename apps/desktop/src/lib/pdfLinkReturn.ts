/**
 * Owns the one-shot return point for PDF-internal link navigation.
 * The revision token also prevents an asynchronously resolved destination from
 * winning after a newer link click, a return command, or a document reset.
 */
export class PdfLinkReturnController {
  private returnOffset: number | undefined;
  private revision = 0;

  beginLink(originOffset: number): number {
    this.returnOffset = Number.isFinite(originOffset) ? Math.max(0, originOffset) : 0;
    this.revision += 1;
    return this.revision;
  }

  consumeReturn(): number | undefined {
    const offset = this.returnOffset;
    if (offset === undefined) {
      return undefined;
    }

    this.returnOffset = undefined;
    this.revision += 1;
    return offset;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }

  reset(): void {
    this.returnOffset = undefined;
    this.revision += 1;
  }
}
