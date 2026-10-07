// Provider error text that some agents report as a normal reply, for example "[System Error] ...".
const FAILED_REPLY = /^\s*\[(system )?error\]/i;

export function isUsableReply(text: string | null): text is string {
  return text !== null && text.trim() !== "" && !FAILED_REPLY.test(text);
}
