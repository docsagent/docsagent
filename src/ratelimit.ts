export class RateLimiter {
  private window = 0;
  private count = 0;

  constructor(private readonly limitPerHour: number) {}

  /** Returns null when allowed, otherwise the ms until the window resets. */
  tryConsume(now: number = Date.now()): number | null {
    const win = Math.floor(now / 3_600_000);
    if (win !== this.window) {
      this.window = win;
      this.count = 0;
    }
    if (this.count + 1 > this.limitPerHour) {
      return (this.window + 1) * 3_600_000 - now;
    }
    this.count += 1;
    return null;
  }

  get remaining(): number {
    const win = Math.floor(Date.now() / 3_600_000);
    if (win !== this.window) return this.limitPerHour;
    return Math.max(0, this.limitPerHour - this.count);
  }
}
