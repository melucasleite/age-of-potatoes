// Storage talks. The sim cannot — it has no `console` — so every diagnostic the save layer
// produces surfaces here, prefixed so it is greppable in a console full of Pixi warnings.
//
// These are deliberately plain `console` calls rather than a logger abstraction. The whole
// audience is one developer with DevTools open, and work item 013's dev overlay reads the
// same data through the returned result objects rather than by scraping messages.

const PREFIX = '[snack-mogul/storage]';

export function logInfo(message: string, detail?: unknown): void {
  if (detail === undefined) console.info(`${PREFIX} ${message}`);
  else console.info(`${PREFIX} ${message}`, detail);
}

export function logWarn(message: string, detail?: unknown): void {
  if (detail === undefined) console.warn(`${PREFIX} ${message}`);
  else console.warn(`${PREFIX} ${message}`, detail);
}

export function logError(message: string, detail?: unknown): void {
  if (detail === undefined) console.error(`${PREFIX} ${message}`);
  else console.error(`${PREFIX} ${message}`, detail);
}
