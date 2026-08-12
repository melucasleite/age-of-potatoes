// The three ways a save can fail to load, as distinguishable types.
//
// They are separate classes rather than one error with a string because the *caller's*
// correct response differs, and that difference is the whole point:
//
//   SaveCorruptError       — the bytes are not a save. Try the `previous` copy.
//   SaveFormatTooNewError  — a stale deploy met a newer save. REFUSE AND WRITE NOTHING.
//                            Overwriting here destroys a world the player still has.
//   SaveMigrationMissingError — the chain has a hole. That is a bug in this repo, not in
//                            the file, and it must be loud rather than silently skipped.

/** Base class, so a host can catch every save failure with one clause. */
export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveError';
  }
}

/** The stored value is not a well-formed envelope, or its payload does not describe a world. */
export class SaveCorruptError extends SaveError {
  constructor(message: string) {
    super(message);
    this.name = 'SaveCorruptError';
  }
}

/**
 * The save was written by a newer build than the one reading it.
 *
 * There is no forward migration and there never will be — a chain only runs one way. The
 * correct behaviour is to refuse the load and leave the stored record untouched, because
 * the player's world is fine and it is the tab that is out of date.
 */
export class SaveFormatTooNewError extends SaveError {
  readonly saveFormatVersion: number;
  readonly currentFormatVersion: number;

  constructor(saveFormatVersion: number, currentFormatVersion: number) {
    super(
      `This save was written by a newer version of the game (save format ${String(
        saveFormatVersion,
      )}, this build reads up to ${String(currentFormatVersion)}). ` +
        'Refusing to load it so that it is not overwritten. Reload to get the newest build.',
    );
    this.name = 'SaveFormatTooNewError';
    this.saveFormatVersion = saveFormatVersion;
    this.currentFormatVersion = currentFormatVersion;
  }
}

/** A step in the migration chain is absent. Always a bug in `MIGRATIONS`, never in the file. */
export class SaveMigrationMissingError extends SaveError {
  readonly fromVersion: number;

  constructor(fromVersion: number) {
    super(
      `No migration registered from save format ${String(fromVersion)} to ${String(
        fromVersion + 1,
      )}. The chain in migrations.ts has a hole in it.`,
    );
    this.name = 'SaveMigrationMissingError';
    this.fromVersion = fromVersion;
  }
}
