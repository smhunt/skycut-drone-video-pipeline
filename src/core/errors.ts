/** An expected, user-actionable failure — message is shown to the agent/user verbatim. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export function driveNotMountedError(sourcePath: string): UserError {
  return new UserError(
    `Source path not found: ${sourcePath} — drive not mounted? Reconnect the USB drive and retry. ` +
      `Use skycut_list_volumes to see mounted volumes.`
  );
}
