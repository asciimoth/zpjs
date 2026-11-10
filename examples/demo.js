import { setTimeout as delay } from "node:timers/promises";
import { Progress } from "zpjs";

const progress = new Progress({ name: "build", estimatedTotalItems: 2 });
try {
  for (const name of ["assets", "code"]) {
    const task = progress.root.start(name, 10);
    try {
      for (let i = 0; i < 10; i++) {
        await delay(40);
        task.completeOne();
      }
    } finally {
      task.end();
    }
  }
} finally {
  progress.close();
}
