// Shared by the plugin (before sending a digest) and the service (before storing one).

// Provider error text that some agents report as a normal reply, for example "[System Error] ...".
const FAILED_REPLY = /^\s*\[(system )?error\]/i;

// A turn without a usable reply (failed, empty or an error banner) does not become a session digest.
export function isUsableReply(text: string | null): text is string {
  return text !== null && text.trim() !== "" && !FAILED_REPLY.test(text);
}
