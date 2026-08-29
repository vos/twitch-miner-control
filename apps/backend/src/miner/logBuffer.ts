/** Ring buffer of miner output. Display only — never parsed for state. */
export class LogBuffer {
  private buffer: string[] = [];
  constructor(private readonly capacity = 2000) {}

  push(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      this.buffer.push(line);
    }
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  }

  lines(): string[] {
    return [...this.buffer];
  }
}
