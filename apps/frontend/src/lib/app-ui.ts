/**
 * App types with no web interface worth linking to.
 *
 * In lib because two screens ask. A game server answers a browser with a protocol error, so offering
 * an "open" link for one is a link that always fails.
 */
export const NO_WEB_UI_APP_TYPES = new Set(['palworld']);
