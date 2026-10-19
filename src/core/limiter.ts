/** Small promise concurrency limiter (p-limit style) with adjustable concurrency. */
export class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(public concurrency: number) {}

  get pending(): number {
    return this.queue.length + this.active;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.next();
          });
      };
      this.queue.push(start);
      this.next();
    });
  }

  private next(): void {
    while (this.active < Math.max(1, this.concurrency) && this.queue.length) this.queue.shift()!();
  }
}
