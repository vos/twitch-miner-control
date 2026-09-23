/**
 * Captures an element as a 2x PNG and downloads it.
 *
 * modern-screenshot is imported here, on demand: it is only needed the
 * moment someone exports, and most visits never do.
 */
export async function exportPng(node: HTMLElement, filename: string): Promise<void> {
  const { domToPng } = await import("modern-screenshot");
  const url = await domToPng(node, { scale: 2 });
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
}
