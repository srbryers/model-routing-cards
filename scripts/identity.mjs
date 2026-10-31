/** Live identities only. Historical receipts must never be relabelled. */
export const LUNA_MODEL = 'gpt-5.6-luna';
export const LUNA_CARD = `openai/${LUNA_MODEL}`;
export function assertLiveIdentity(value) {
  const text = JSON.stringify(value);
  if (/gpt-6-luna/.test(text ?? '')) throw new TypeError('Stale Luna identity: use gpt-5.6-luna and openai/gpt-5.6-luna; quarantine old measurements');
}
