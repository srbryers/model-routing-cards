/** Small, dependency-free adapter for Cloudflare's hosted Clef System One API. */

export const CLEF_PRICING = Object.freeze({
  models: Object.freeze({ clef: 0.24, 'clef-flash': 0.09 }),
  inputUsdPerMillion: Object.freeze({ clef: 0.24, 'clef-flash': 0.09 }),
  maxInputTokensPerRequest: 65_536,
  maxStateBytes: 12 * 1024,
  maxQuestions: 64,
  maxImages: 4,
  maxImageBytes: 4 * 1024 * 1024,
  maxTotalImageBytes: 8 * 1024 * 1024,
  maxImagePixels: 16_000_000,
  maxRequestBytes: 13 * 1024 * 1024,
  maxTimeoutMs: 30_000,
  source: 'https://developers.cloudflare.com/workers-ai/models/clef/',
  pricingSource: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  verifiedOn: '2026-10-03',
});

const MODEL_IDS = new Set(Object.keys(CLEF_PRICING.inputUsdPerMillion));
const QUESTION_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const MIME_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/webp', 'webp'],
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serialise(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
  if (encoded === undefined) throw new Error(`${label} must be JSON-serializable`);
  return encoded;
}

function validateCriteriaValue(value, label) {
  if (typeof value === 'string') {
    if (!value.trim()) throw new Error(`${label} must be a concrete, non-empty description`);
    return;
  }
  if (value === null || (Array.isArray(value) && value.length === 0)) {
    throw new Error(`${label} must be a concrete description`);
  }
  if (!record(value) && !Array.isArray(value)) throw new Error(`${label} must be text or structured data`);
  const encoded = serialise(value, label);
  if (encoded === '{}' || encoded === '[]') throw new Error(`${label} must be a concrete description`);
}

function validateQuestions(questions) {
  if (!record(questions)) throw new Error('questions must be an object');
  const entries = Object.entries(questions);
  if (entries.length < 1 || entries.length > CLEF_PRICING.maxQuestions) {
    throw new Error(`questions must contain 1 to ${CLEF_PRICING.maxQuestions} items`);
  }
  for (const [id, question] of entries) {
    if (!QUESTION_ID.test(id)) throw new Error(`question id "${id}" must use 1 to 64 safe characters`);
    if (!record(question)) throw new Error(`question "${id}" must be an object`);
    if (typeof question.instructions !== 'string' || !question.instructions.trim()) {
      throw new Error(`question "${id}" needs non-empty instructions`);
    }
    if (question.type === 'noul') {
      if (question.criteria !== undefined) {
        if (!record(question.criteria)) throw new Error(`noul question "${id}" criteria must be an object`);
        for (const key of ['true', 'false']) {
          if (question.criteria[key] !== undefined) validateCriteriaValue(question.criteria[key], `question "${id}" ${key} criterion`);
        }
      }
    } else if (question.type === 'choice') {
      if (!record(question.criteria)) throw new Error(`choice question "${id}" needs criteria keyed by option id`);
      const options = Object.entries(question.criteria);
      if (options.length < 2 || options.length > 255) throw new Error(`choice question "${id}" needs 2 to 255 options`);
      for (const [optionId, description] of options) {
        if (!optionId.trim()) throw new Error(`choice question "${id}" has an empty option id`);
        validateCriteriaValue(description, `question "${id}" option "${optionId}"`);
      }
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10) {
        throw new Error(`score question "${id}" needs 2 to 10 ordered criteria`);
      }
      question.criteria.forEach((criterion, index) => validateCriteriaValue(criterion, `question "${id}" level ${index}`));
    } else {
      throw new Error(`question "${id}" has unsupported type`);
    }
  }
}

function readU24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (sof.has(marker)) {
      if (length < 7) return null;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes) {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = bytes.toString('ascii', 12, 16);
  if (kind === 'VP8X' && bytes.length >= 30) {
    return { width: readU24LE(bytes, 24) + 1, height: readU24LE(bytes, 27) + 1 };
  }
  if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
    return {
      width: 1 + b1 + ((b2 & 0x3f) << 8),
      height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
    };
  }
  if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function dimensionsFor(mime, bytes) {
  if (mime === 'image/png') return pngDimensions(bytes);
  if (mime === 'image/jpeg') return jpegDimensions(bytes);
  return webpDimensions(bytes);
}

function parseImage(image, index) {
  let mime;
  let base64;
  if (typeof image === 'string') {
    if (/^https?:\/\//i.test(image)) throw new Error(`image ${index} remote URLs are not accepted`);
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(image);
    if (!match) throw new Error(`image ${index} must be a PNG, JPEG, or WebP base64 data URL`);
    mime = match[1].toLowerCase();
    base64 = match[2];
  } else if (record(image)) {
    mime = typeof image.content_type === 'string' ? image.content_type.toLowerCase() : '';
    base64 = image.base64;
    if (!MIME_EXTENSIONS.has(mime) || typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new Error(`image ${index} needs content_type and base64 image bytes`);
    }
  } else {
    throw new Error(`image ${index} must be an embedded image`);
  }
  if (base64.length % 4 !== 0) throw new Error(`image ${index} has invalid base64`);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) throw new Error(`image ${index} has invalid base64`);
  if (bytes.byteLength === 0 || bytes.byteLength > CLEF_PRICING.maxImageBytes) {
    throw new Error(`image ${index} must be between 1 byte and 4 MiB decoded`);
  }
  const dimensions = dimensionsFor(mime, bytes);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new Error(`image ${index} has an invalid or unsupported image header`);
  if (dimensions.width * dimensions.height > CLEF_PRICING.maxImagePixels) throw new Error(`image ${index} exceeds 16 megapixels`);
  return { byteLength: bytes.byteLength };
}

/** Validate and prepare a request without consulting credentials or making a request. */
export function validateClefRequest({ accountId, model = 'clef', state, questions, images, video, videos }) {
  if (video !== undefined || videos !== undefined) throw new Error('video input is unsupported by this hosted adapter');
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) throw new Error('accountId must be a valid Cloudflare account identifier');
  if (typeof model !== 'string' || !MODEL_IDS.has(model)) throw new Error('model must be "clef" or "clef-flash"');
  if (state === undefined) throw new Error('state is required');
  validateQuestions(questions);
  const stateJson = serialise(state, 'state');
  const stateBytes = Buffer.byteLength(stateJson, 'utf8');
  const questionsBytes = Buffer.byteLength(serialise(questions, 'questions'), 'utf8');
  const contextBytes = stateBytes + questionsBytes;
  if (contextBytes > CLEF_PRICING.maxStateBytes) {
    throw new Error(`serialized state and questions are ${contextBytes} UTF-8 bytes; maximum is ${CLEF_PRICING.maxStateBytes} (input is never truncated)`);
  }
  if (images !== undefined && !Array.isArray(images)) throw new Error('images must be an array of embedded images');
  const imageList = images ?? [];
  if (imageList.length > CLEF_PRICING.maxImages) throw new Error('at most 4 embedded images are supported');
  let decodedImageBytes = 0;
  imageList.forEach((image, index) => { decodedImageBytes += parseImage(image, index).byteLength; });
  if (decodedImageBytes > CLEF_PRICING.maxTotalImageBytes) throw new Error('decoded images exceed the 8 MiB total limit');
  const payload = { model, state, questions, ...(imageList.length ? { images: imageList } : {}) };
  const body = serialise(payload, 'request');
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > CLEF_PRICING.maxRequestBytes) throw new Error(`request body exceeds the 13 MiB limit (${bodyBytes} bytes)`);
  return { accountId, model, stateBytes, questionsBytes, contextBytes, decodedImageBytes, bodyBytes, body };
}

function validProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function unknownAnswer(type, reason) {
  return { type, status: 'unknown', reason, selected: null, distribution: null, confidence: null, score: null };
}

function checkedDistribution(probabilities, expectedKeys) {
  if (!record(probabilities)) return null;
  const keys = Object.keys(probabilities).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== [...expectedKeys].sort()[index])) return null;
  if (keys.some((key) => !validProbability(probabilities[key]))) return null;
  const total = Object.values(probabilities).reduce((sum, probability) => sum + probability, 0);
  if (Math.abs(total - 1) > 0.01) return null;
  return Object.fromEntries(keys.map((key) => [key, probabilities[key]]));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeAnswer(question, answer) {
  const type = question.type;
  if (!record(answer) || answer.type !== type) return unknownAnswer(type, 'missing_or_type_mismatch');
  if (type === 'noul') {
    if (!validProbability(answer.noul)) return unknownAnswer(type, 'invalid_probability');
    return {
      type,
      status: 'known',
      selected: answer.noul >= 0.5,
      probabilityYes: answer.noul,
      distribution: { false: Number((1 - answer.noul).toFixed(12)), true: answer.noul },
      confidence: null,
      score: null,
      raw: answer,
    };
  }
  const expectedKeys = type === 'choice'
    ? Object.keys(question.criteria)
    : question.criteria.map((_, index) => String(index));
  const distribution = checkedDistribution(answer.probabilities, expectedKeys);
  if (!distribution) return unknownAnswer(type, 'invalid_or_incomplete_distribution');
  if (!validProbability(answer.confidence)) return unknownAnswer(type, 'invalid_confidence');
  if (type === 'choice') {
    if (typeof answer.choice !== 'string' || !expectedKeys.includes(answer.choice)) return unknownAnswer(type, 'selector_mismatch');
    const highest = Math.max(...Object.values(distribution));
    if (distribution[answer.choice] !== highest) return unknownAnswer(type, 'selector_mismatch');
    return { type, status: 'known', selected: answer.choice, distribution, confidence: answer.confidence, score: null, raw: answer };
  }
  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1) {
    return unknownAnswer(type, 'invalid_score');
  }
  if (!record(answer.legend) || Object.keys(answer.legend).length !== expectedKeys.length) return unknownAnswer(type, 'invalid_legend');
  for (let index = 0; index < question.criteria.length; index++) {
    const key = String(index);
    if (!Object.hasOwn(answer.legend, key) || stableJson(answer.legend[key]) !== stableJson(question.criteria[index])) {
      return unknownAnswer(type, 'invalid_legend');
    }
  }
  const expectedScore = question.criteria.reduce((sum, _criterion, index) => sum + index * distribution[String(index)], 0);
  if (Math.abs(answer.score - expectedScore) > 0.02) return unknownAnswer(type, 'score_distribution_mismatch');
  return { type, status: 'known', selected: null, distribution, confidence: answer.confidence, score: answer.score, raw: answer };
}

/** Normalize a raw System One answer map without assuming a provider envelope. */
export function normalizeSystemOneAnswers(questions, returnedAnswers) {
  validateQuestions(questions);
  const source = record(returnedAnswers) ? returnedAnswers : {};
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [
    id,
    normalizeAnswer(question, source[id]),
  ]));
}

function normalizeUsage(usage) {
  const source = record(usage) ? usage : {};
  const inputTokens = source.input_tokens ?? source.prompt_tokens ?? null;
  const outputTokens = source.output_tokens ?? source.completion_tokens ?? null;
  return {
    inputTokens: Number.isInteger(inputTokens) && inputTokens >= 0 ? inputTokens : null,
    outputTokens: Number.isInteger(outputTokens) && outputTokens >= 0 ? outputTokens : null,
    raw: source,
  };
}

export function clefInputCostUsd(model, usage = {}) {
  if (!MODEL_IDS.has(model)) throw new Error('model must be "clef" or "clef-flash"');
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens;
  if (!Number.isInteger(inputTokens) || inputTokens < 0) return null;
  return Number(((inputTokens / 1_000_000) * CLEF_PRICING.inputUsdPerMillion[model]).toFixed(12));
}

/** Reserve Cloudflare's full published context window before a bounded paid batch. */
export function assertClefBudget({ model = 'clef', limitUsd, spentUsd = 0, maxRequests = 1 }) {
  if (!MODEL_IDS.has(model)) throw new Error('model must be "clef" or "clef-flash"');
  for (const [name, value] of Object.entries({ limitUsd, spentUsd, maxRequests })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  }
  if (!Number.isInteger(maxRequests)) throw new Error('maxRequests must be an integer');
  const rate = CLEF_PRICING.inputUsdPerMillion[model];
  const reserveUsd = Number((maxRequests * CLEF_PRICING.maxInputTokensPerRequest * rate / 1_000_000).toFixed(12));
  const remainingUsd = Number((limitUsd - spentUsd).toFixed(12));
  if (reserveUsd > remainingUsd) throw new Error(`Clef budget refused: ${maxRequests} request(s) can cost up to $${reserveUsd.toFixed(6)}, but only $${Math.max(0, remainingUsd).toFixed(6)} remains`);
  return { model, limitUsd, spentUsd, remainingUsd, reserveUsd, maxRequests };
}

/**
 * Run one Cloudflare Clef request. `apiToken` and `readToken` are explicit
 * injection points; import and validation have no credential side effects.
 */
export async function clef({
  accountId,
  model = 'clef',
  state,
  questions,
  images,
  video,
  videos,
  apiToken,
  readToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
}) {
  const prepared = validateClefRequest({ accountId, model, state, questions, images, video, videos });
  if (apiToken !== undefined && readToken !== undefined) throw new Error('provide apiToken or readToken, not both');
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CLEF_PRICING.maxTimeoutMs) {
    throw new Error(`timeoutMs must be an integer from 1 to ${CLEF_PRICING.maxTimeoutMs}`);
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');
  const token = apiToken ?? (typeof readToken === 'function' ? await readToken() : undefined);
  if (typeof token !== 'string' || !token.trim()) throw new Error('a Cloudflare API token must be injected');

  const url = `https://api.cloudflare.com/client/v4/accounts/${prepared.accountId}/ai/run/@cf/cloudflare/${prepared.model}`;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Clef request timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  let envelope;
  try {
    const operation = (async () => {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: prepared.body,
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw new Error(`Clef request timed out after ${timeoutMs} ms`);
        throw new Error('Clef request failed before receiving a response');
      }
      if (!response?.ok) throw new Error(`Cloudflare Clef answered HTTP ${Number.isInteger(response?.status) ? response.status : 'error'}`);
      try {
        return await response.json();
      } catch {
        if (controller.signal.aborted) throw new Error(`Clef request timed out after ${timeoutMs} ms`);
        throw new Error('Cloudflare Clef returned malformed JSON');
      }
    })();
    envelope = await Promise.race([operation, timeout]);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Clef request timed out after ${timeoutMs} ms`);
    if (error?.message?.startsWith('Cloudflare Clef answered HTTP ')) throw error;
    if (error?.message === 'Cloudflare Clef returned malformed JSON') throw error;
    if (error?.message === 'Clef request failed before receiving a response') throw error;
    throw new Error('Cloudflare Clef request failed');
  } finally {
    clearTimeout(timer);
  }
  if (!record(envelope) || envelope.success !== true || !record(envelope.result)) {
    throw new Error('Cloudflare Clef returned an unsuccessful or malformed response');
  }
  const result = envelope.result;
  const resolvedModel = typeof result.model === 'string' ? result.model : null;
  const selectorMatches = resolvedModel === model;
  const returnedAnswers = record(result.answers) ? result.answers : {};
  const answers = selectorMatches
    ? normalizeSystemOneAnswers(questions, returnedAnswers)
    : Object.fromEntries(Object.entries(questions).map(([id, question]) => [
      id,
      unknownAnswer(question.type, 'resolved_model_mismatch'),
    ]));
  const usage = normalizeUsage(result.usage);
  const chargedModel = selectorMatches ? (resolvedModel ?? model) : null;
  const inputUsd = chargedModel ? clefInputCostUsd(chargedModel, result.usage ?? {}) : null;
  return {
    requestedModel: model,
    resolvedModel,
    // The public REST contract reports a model name, not an immutable revision.
    modelRevision: null,
    modelMatchesRequest: selectorMatches,
    answers,
    usage,
    cost: {
      inputUsd,
      inputUsdPerMillion: chargedModel ? CLEF_PRICING.inputUsdPerMillion[chargedModel] : null,
      currency: 'USD',
      basis: inputUsd === null ? 'unavailable' : 'published-input-token-estimate',
      source: CLEF_PRICING.pricingSource,
      verifiedOn: CLEF_PRICING.verifiedOn,
    },
    response: result,
  };
}

export default clef;
