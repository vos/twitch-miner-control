/** Ring buffer of miner output. Display only — never parsed for state. */
export class LogBuffer {
  private buffer: string[] = [];
  private kept = 0;
  constructor(private readonly capacity = 2000) {}

  /**
   * Every line ever kept, including those since evicted. A reader that knows
   * the total its copy ends at can tell which pushed lines it already has.
   */
  get total(): number {
    return this.kept;
  }

  /** Keeps a chunk's non-empty lines and returns them. */
  push(chunk: string): string[] {
    const lines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      this.buffer.push(line);
      lines.push(line);
    }
    this.kept += lines.length;
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    return lines;
  }

  lines(): string[] {
    return [...this.buffer];
  }
}
