export interface ReviewerLock {
  runExclusive<T>(operation: () => Promise<T> | T): Promise<T>;
}

export class SerializedReviewerLock implements ReviewerLock {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  async runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;

    this.pending += 1;
    this.tail = new Promise<void>((resolve) => {
      release = () => {
        this.pending -= 1;
        resolve();
      };
    });

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
    }
  }

  getPendingCount() {
    return this.pending;
  }
}
