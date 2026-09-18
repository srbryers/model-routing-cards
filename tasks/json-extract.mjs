/**
 * A small live task, to exercise the runner end to end for pennies.
 *
 * Structured extraction is a good first real task: it is cheap, the gates are
 * unambiguous (did it parse, are the fields there), and the metric is a fact
 * rather than taste — so a bad card here is the tool's fault, not the scorer's.
 */
const SOURCE = `
The wedding is on 31 May 2027 at Palacio de Buenavista in Toledo, Spain.
Guests mostly fly into Madrid-Barajas (MAD); Barcelona (BCN) is an alternative.
The train from Madrid Atocha takes 33 minutes and costs EUR 13.90.
Hire car is about 75 minutes via the A-42. Roughly 300 guests are invited.
`;

const WANT = ['date', 'venue', 'city', 'primary_airport', 'train_minutes', 'train_price_eur'];

export const task = {
  id: 'json-extract',
  /* ⚠ gpt-5.5 goes through the ChatGPT SUBSCRIPTION, not OpenRouter — the
     OpenRouter balance refused it with a 402 and the subscription is paid for.
     `chatgpt:` uses the hosted route directly, the way pi-imagen does; `codex:`
     shells out to the CLI, which on this machine can no longer decode the
     service's models response. */
  models: ['google/gemini-3.8-flash', 'chatgpt:gpt-5.5', 'codex:gpt-5.5'],
  runs: 3,
  input: { source: SOURCE },

  prompt: (input) =>
    `Extract these fields from the passage as a flat JSON object with exactly ` +
    `these keys: ${WANT.join(', ')}. Numbers as numbers, not strings. ` +
    `Reply with JSON only, no prose and no code fence.\n\n${input.source}`,

  score: (output) => {
    let obj;
    try {
      /* A fence is not a parse failure — it is a formatting miss, and worth
         scoring separately from "returned something that is not JSON at all". */
      const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
      obj = JSON.parse(fenced ? fenced[1] : output);
    } catch {
      return { gates: { parses: false, has_fields: false }, metrics: {} };
    }
    const present = WANT.filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '');

    /* ⚠ THE FACTS ARE CHECKED, NOT JUST THE SHAPE. A model that returns all six
       keys with invented values passes every structural test — which is the
       whole reason "it returned valid JSON" is a gate and not a score. */
    const correct = [
      String(obj.train_minutes) === '33',
      String(obj.train_price_eur) === '13.9' || String(obj.train_price_eur) === '13.90',
      /MAD/i.test(String(obj.primary_airport ?? '')),
      /toledo/i.test(String(obj.city ?? '')),
    ].filter(Boolean).length;

    return {
      gates: {
        parses: true,
        has_fields: present.length === WANT.length,
        no_extra_keys: Object.keys(obj).length === WANT.length,
      },
      metrics: {
        completeness: present.length / WANT.length,
        accuracy: correct / 4,
        /* Unfenced, as asked. Instruction-following is a measurable thing. */
        clean_format: /^\s*```/.test(output) ? 0 : 1,
      },
    };
  },

  weights: { accuracy: 0.5, completeness: 0.3, clean_format: 0.2 },
};
