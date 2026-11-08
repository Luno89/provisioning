export function defaultServiceType(): string {
  const type = process.env.APP_SERVICE_TYPE;
  if (!type) throw new Error("an app's stack is told how its Service is reached, in APP_SERVICE_TYPE, and it was not");
  return type;
}
